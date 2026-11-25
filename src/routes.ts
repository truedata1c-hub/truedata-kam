// Маршруты согласования (ТЗ §5): конструктор шаблонов, правила выбора, вычисление исполнителей и предпросмотр.
// Вычисление общее для предпросмотра и отправки: что показал предпросмотр, то и заморозится при отправке.

import { randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { ApiError, invalid, notFound, required } from './errors.js';
import { type Ctx, campaignVisibility, requirePermission } from './access.js';
import { type CommandResult, audit, isUuid } from './commands.js';
import { type VersionMetrics, versionMetrics } from './versions.js';

type Q = Pick<Tx, 'query'>;

export const CONDITION_KINDS = ['INVESTMENT_GTE', 'GROWTH_GTE', 'ROI_BELOW_PRIOR', 'TYPE_IN', 'NETWORK_IN', 'GROUP_IN', 'BRAND_IN'] as const;
export type Condition =
  | { kind: 'INVESTMENT_GTE'; amount: number }
  | { kind: 'GROWTH_GTE'; pct: number }
  | { kind: 'ROI_BELOW_PRIOR' }
  | { kind: 'TYPE_IN' | 'NETWORK_IN' | 'GROUP_IN' | 'BRAND_IN'; ids: string[] };
export type Assignee =
  | { kind: 'MANAGER'; level: number }
  | { kind: 'ROLE'; role_id: string; scoped: boolean }
  | { kind: 'USER'; user_id: string };
export interface StepDef { title: string; assignee: Assignee; conditions: Condition[]; deadline_days: number }

const MAX_STEPS = 10;

// Справочники клиента для проверок и подписей --------------------------------

export interface Approver { id: string; name: string; roles: Set<string>; approve: boolean; scopes: Set<string> }
export interface Dir {
  roles: Map<string, { name: string; approve: boolean; archived: boolean }>;
  users: Map<string, Approver>;
  managerOf: Map<string, string>;
  types: Map<string, string>; networks: Map<string, string>; groups: Map<string, string>; brands: Map<string, string>;
}

export async function directory(q: Q, clientId: string): Promise<Dir> {
  const roles = new Map((await q.query<{ id: string; name: string; permissions: string[]; archived: boolean }>(
    'select id, name, permissions, archived from kam.business_role where client_id=$1', [clientId])).rows
    .map((r) => [r.id, { name: r.name, approve: r.permissions.includes('APPROVE'), archived: r.archived }]));
  const { rows: ur } = await q.query<{ id: string; name: string; role_id: string | null }>(
    `select u.id, u.display_name name, ur.role_id from kam.employee_profile u
       left join kam.user_business_role ur on ur.client_id = u.client_id and ur.user_id = u.id
      where u.client_id = $1 and u.active and not u.disabled`, [clientId]);
  const users = new Map<string, Approver>();
  for (const r of ur) {
    const u = users.get(r.id) ?? { id: r.id, name: r.name, roles: new Set<string>(), approve: false, scopes: new Set<string>() };
    const role = r.role_id ? roles.get(r.role_id) : undefined;
    if (r.role_id && role && !role.archived) {
      u.roles.add(r.role_id);
      if (role.approve) u.approve = true;
    }
    users.set(r.id, u);
  }
  const { rows: sc } = await q.query<{ user_id: string; scope: string }>(
    `select ur.user_id, r.scope from kam.user_business_role ur join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id and not r.archived
      where ur.client_id=$1`, [clientId]);
  for (const s of sc) users.get(s.user_id)?.scopes.add(s.scope);
  const managerOf = new Map((await q.query<{ user_id: string; manager_id: string }>(
    'select user_id, manager_id from kam.user_manager where client_id=$1 and valid @> current_date', [clientId])).rows.map((r) => [r.user_id, r.manager_id]));
  const named = async (sql: string) => new Map((await q.query<{ id: string; name: string }>(sql, [clientId])).rows.map((r) => [r.id, r.name]));
  return {
    roles, users, managerOf,
    types: await named('select id, name from kam.campaign_type where client_id=$1'),
    networks: await named('select id, name from kam.network where client_id=$1'),
    groups: await named('select id, name from kam.network_group where client_id=$1'),
    brands: await named('select id, name from kam.brand where client_id=$1'),
  };
}

// Проверка шаблона ---------------------------------------------------------------

function int(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function normalizeSteps(q: Q, clientId: string, raw: unknown, dir?: Dir): Promise<StepDef[]> {
  if (!Array.isArray(raw) || !raw.length) throw invalid('steps', 'Добавьте хотя бы один шаг маршрута.', 'EMPTY_ROUTE');
  if (raw.length > MAX_STEPS) throw invalid('steps', `Не больше ${MAX_STEPS} шагов.`);
  const d = dir ?? await directory(q, clientId);
  return raw.map((s0, i) => {
    const s = (s0 ?? {}) as Record<string, any>;
    const at = `Шаг ${i + 1}: `;
    const title = typeof s.title === 'string' ? s.title.trim().replace(/\s+/g, ' ') : '';
    if (!title) throw invalid('steps', at + 'укажите название шага.');
    if (title.length > 120) throw invalid('steps', at + 'название не длиннее 120 символов.');
    const deadline = int(s.deadline_days, 1, 60);
    if (deadline === null) throw invalid('steps', at + 'срок решения — от 1 до 60 рабочих дней.');
    const a = (s.assignee ?? {}) as Record<string, any>;
    let assignee: Assignee;
    if (a.kind === 'MANAGER') {
      const level = int(a.level ?? 1, 1, 5);
      if (level === null) throw invalid('steps', at + 'уровень руководителя — от 1 до 5.');
      assignee = { kind: 'MANAGER', level };
    } else if (a.kind === 'ROLE') {
      const role = isUuid(a.role_id) ? d.roles.get(a.role_id) : undefined;
      if (!role || role.archived) throw invalid('steps', at + 'выберите действующую роль.');
      if (!role.approve) throw invalid('steps', at + `у роли «${role.name}» нет полномочия «Согласовывать».`, 'ROLE_CANNOT_APPROVE');
      if (![...d.users.values()].some((u) => u.roles.has(a.role_id))) throw invalid('steps', at + `нет активных пользователей с ролью «${role.name}».`, 'NO_ASSIGNEE');
      assignee = { kind: 'ROLE', role_id: a.role_id, scoped: Boolean(a.scoped) };
    } else if (a.kind === 'USER') {
      const u = isUuid(a.user_id) ? d.users.get(a.user_id) : undefined;
      if (!u) throw invalid('steps', at + 'выберите активного пользователя.');
      if (!u.approve) throw invalid('steps', at + `у пользователя ${u.name} нет полномочия «Согласовывать».`, 'NO_ASSIGNEE');
      assignee = { kind: 'USER', user_id: a.user_id };
    } else throw invalid('steps', at + 'выберите исполнителя.');
    if (s.conditions !== undefined && !Array.isArray(s.conditions)) throw invalid('steps', at + 'некорректные условия.');
    const conditions: Condition[] = ((s.conditions ?? []) as Record<string, any>[]).map((c) => {
      switch (c?.kind) {
        case 'INVESTMENT_GTE': {
          const amount = Number(c.amount);
          if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw invalid('steps', at + 'порог инвестиций — положительная сумма.');
          return { kind: 'INVESTMENT_GTE', amount: Math.round(amount * 100) / 100 };
        }
        case 'GROWTH_GTE': {
          const pct = Number(c.pct);
          if (!Number.isFinite(pct) || pct < -100 || pct > 1000) throw invalid('steps', at + 'рост инвестиций — от −100 до 1000 %.');
          return { kind: 'GROWTH_GTE', pct: Math.round(pct * 10) / 10 };
        }
        case 'ROI_BELOW_PRIOR': return { kind: 'ROI_BELOW_PRIOR' };
        case 'TYPE_IN': case 'NETWORK_IN': case 'GROUP_IN': case 'BRAND_IN': {
          const ids = Array.isArray(c.ids) ? [...new Set(c.ids as unknown[])] : [];
          const map = { TYPE_IN: d.types, NETWORK_IN: d.networks, GROUP_IN: d.groups, BRAND_IN: d.brands }[c.kind as 'TYPE_IN'];
          if (!ids.length || !ids.every((x) => isUuid(x) && map.has(x))) throw invalid('steps', at + 'выберите значения условия.');
          return { kind: c.kind, ids: ids as string[] };
        }
        default: throw invalid('steps', at + 'неизвестное условие.');
      }
    });
    if (new Set(conditions.map((c) => c.kind)).size !== conditions.length) throw invalid('steps', at + 'каждое условие — не больше одного раза.');
    return { title, assignee, conditions, deadline_days: deadline };
  });
}

// Подписи -----------------------------------------------------------------------

export function fmtMoney(v: number): string {
  const f = (x: number, d: number) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (Math.abs(v) >= 1e9) return `${f(v / 1e9, 1)} млрд ₽`;
  if (Math.abs(v) >= 1e6) return `${f(v / 1e6, 1)} млн ₽`;
  if (Math.abs(v) >= 1e3) return `${f(v / 1e3, 0)} тыс. ₽`;
  return `${f(v, 0)} ₽`;
}
const names = (ids: string[], m: Map<string, string>) => ids.map((x) => m.get(x) ?? '—').join(', ');

function assigneeText(a: Assignee, d: Dir): string {
  if (a.kind === 'MANAGER') return a.level === 1 ? 'Руководитель автора' : `Руководитель автора уровня ${a.level}`;
  if (a.kind === 'ROLE') return `Роль «${d.roles.get(a.role_id)?.name ?? '—'}»${a.scoped ? ' с доступом к сети' : ''}`;
  return d.users.get(a.user_id)?.name ?? 'Пользователь недоступен';
}

function conditionText(c: Condition, d: Dir): string {
  switch (c.kind) {
    case 'INVESTMENT_GTE': return `инвестиции ≥ ${fmtMoney(c.amount)}`;
    case 'GROWTH_GTE': return `рост инвестиций к факту прошлого периода ≥ ${c.pct} %`;
    case 'ROI_BELOW_PRIOR': return 'ROI ниже факта прошлого периода';
    case 'TYPE_IN': return `тип: ${names(c.ids, d.types)}`;
    case 'NETWORK_IN': return `сеть: ${names(c.ids, d.networks)}`;
    case 'GROUP_IN': return `группа сетей: ${names(c.ids, d.groups)}`;
    case 'BRAND_IN': return `бренд в разбивке: ${names(c.ids, d.brands)}`;
  }
}

// Вычисление маршрута -------------------------------------------------------------

export interface RouteCampaign { id: string; owner_id: string | null; network_id: string; type_id: string; group_id: string | null; period_from: string; period_to: string }

export interface ResolvedStep {
  position: number; title: string; assignee_rule: string; condition_text: string; deadline_days: number;
  included: boolean; skip_reason: string | null;
  candidates: { id: string; name: string }[]; assign_note: string | null; error: string | null;
}

/** Условие включения: проверяется по итогам версии и прошлому периоду. Без данных прошлого периода шаг включается. */
function evaluate(c: Condition, m: VersionMetrics | null, camp: RouteCampaign, d: Dir): string | null {
  switch (c.kind) {
    case 'INVESTMENT_GTE':
      if (!m) return null;
      return m.investment >= c.amount ? null : `Инвестиции ${fmtMoney(m.investment)} меньше порога ${fmtMoney(c.amount)}.`;
    case 'GROWTH_GTE': {
      if (!m || !m.prior_fact_investment) return null;
      const g = Math.round(((m.investment / m.prior_fact_investment) - 1) * 1000) / 10;
      return g >= c.pct ? null : `Рост инвестиций к факту прошлого периода ${g.toLocaleString('ru-RU')} % меньше ${c.pct} %.`;
    }
    case 'ROI_BELOW_PRIOR':
      if (!m || m.roi === null || m.prior_fact_roi === null) return null;
      return m.roi < m.prior_fact_roi ? null : `ROI ${m.roi.toLocaleString('ru-RU')}× не ниже факта прошлого периода ${m.prior_fact_roi.toLocaleString('ru-RU')}×.`;
    case 'TYPE_IN': return c.ids.includes(camp.type_id) ? null : `Тип кампании не входит в условие (${names(c.ids, d.types)}).`;
    case 'NETWORK_IN': return c.ids.includes(camp.network_id) ? null : `Сеть не входит в условие (${names(c.ids, d.networks)}).`;
    case 'GROUP_IN': return camp.group_id && c.ids.includes(camp.group_id) ? null : `Группа сети не входит в условие (${names(c.ids, d.groups)}).`;
    case 'BRAND_IN':
      if (!m) return null;
      return c.ids.some((b) => m.brand_ids.includes(b)) ? null : `В разбивке нет брендов: ${names(c.ids, d.brands)}.`;
  }
}

/** Видит ли пользователь кампанию по своей роли (уточнение «с доступом к сети»). */
export function canSee(u: Approver, camp: Pick<RouteCampaign, 'owner_id'>, d: Dir): boolean {
  if (u.scopes.has('ALL') || u.scopes.has('BRANDS')) return true;
  if (!camp.owner_id) return false;
  const team = new Set<string>([u.id]);
  if (u.scopes.has('SUBORDINATES')) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [sub, mgr] of d.managerOf) if (team.has(mgr) && !team.has(sub)) { team.add(sub); grew = true; }
    }
  }
  return team.has(camp.owner_id);
}

export function resolveSteps(steps: StepDef[], camp: RouteCampaign, m: VersionMetrics | null, submitterId: string, d: Dir): ResolvedStep[] {
  const excluded = new Set([submitterId, camp.owner_id]);
  const eligible = (id: string | undefined) => (id ? d.users.get(id) : undefined);
  const chainOf = (start: string) => {
    const out: string[] = [];
    let cur = d.managerOf.get(start);
    while (cur && out.length < 20 && !out.includes(cur)) { out.push(cur); cur = d.managerOf.get(cur); }
    return out;
  };
  /** Первый руководитель выше по цепочке с правом согласования, кроме автора и ответственного. */
  const escalate = (chain: string[]) => chain.map(eligible).find((u) => u && u.approve && !excluded.has(u.id));
  return steps.map((s, i) => {
    const base = {
      position: i + 1, title: s.title, assignee_rule: assigneeText(s.assignee, d),
      condition_text: s.conditions.map((c) => conditionText(c, d)).join('; '), deadline_days: s.deadline_days,
    };
    const fail = s.conditions.map((c) => evaluate(c, m, camp, d)).find((x) => x);
    if (fail) return { ...base, included: false, skip_reason: fail, candidates: [], assign_note: null, error: null };
    let candidates: Approver[] = [];
    let note: string | null = null;
    let error: string | null = null;
    const a = s.assignee;
    if (a.kind === 'MANAGER') {
      const chain = camp.owner_id ? chainOf(camp.owner_id) : [];
      const target = chain[a.level - 1];
      if (!target) error = a.level === 1 ? 'У ответственного не указан руководитель.' : `У ответственного нет руководителя уровня ${a.level}.`;
      else {
        const t = eligible(target);
        if (t && t.approve && !excluded.has(t.id)) candidates = [t];
        else {
          const up = escalate(chain.slice(a.level));
          const who = d.users.get(target)?.name ?? 'Руководитель';
          const why = excluded.has(target) ? 'сам отправил кампанию' : 'не может согласовывать';
          if (up) { candidates = [up]; note = `${who} ${why} — шаг передан руководителю следующего уровня.`; }
          else error = `${who} ${why}, а выше по оргструктуре нет руководителя с правом согласования.`;
        }
      }
    } else if (a.kind === 'ROLE') {
      const withRole = [...d.users.values()].filter((u) => u.roles.has(a.role_id) && u.approve);
      const visible = a.scoped ? withRole.filter((u) => canSee(u, camp, d)) : withRole;
      candidates = visible.filter((u) => !excluded.has(u.id));
      if (!candidates.length) {
        const role = d.roles.get(a.role_id)?.name ?? '—';
        if (visible.length) {
          const up = escalate(chainOf(submitterId));
          if (up) { candidates = [up]; note = `Единственный исполнитель с ролью «${role}» — автор; шаг передан его руководителю.`; }
          else error = `Единственный исполнитель с ролью «${role}» — автор, а руководителя с правом согласования нет.`;
        } else error = `Нет активных пользователей с ролью «${role}»${a.scoped ? ' и доступом к этой сети' : ''}.`;
      }
    } else {
      const u = eligible(a.user_id);
      if (!u || !u.approve) error = 'Указанный в шаге пользователь отключён или не может согласовывать.';
      else if (excluded.has(u.id)) {
        const up = escalate(chainOf(submitterId));
        if (up) { candidates = [up]; note = `${u.name} — автор; шаг передан руководителю автора.`; }
        else error = `${u.name} — автор, а руководителя с правом согласования нет.`;
      } else candidates = [u];
    }
    candidates.sort((x, y) => x.name.localeCompare(y.name, 'ru'));
    return { ...base, included: true, skip_reason: null, candidates: candidates.map((u) => ({ id: u.id, name: u.name })), assign_note: note, error };
  });
}

// Выбор шаблона и вычисление для кампании ----------------------------------------

export interface TemplateRow { id: string; name: string; steps: StepDef[]; tolerance_investment_pct: number; tolerance_turnover_pct: number }

export async function selectTemplate(q: Q, clientId: string, camp: Pick<RouteCampaign, 'type_id' | 'group_id'>): Promise<TemplateRow & { rule: string }> {
  const cols = 't.id, t.name, t.steps, t.tolerance_investment_pct::float8 tolerance_investment_pct, t.tolerance_turnover_pct::float8 tolerance_turnover_pct';
  const { rows } = await q.query<TemplateRow & { priority: number }>(
    `select ${cols}, r.priority from kam.route_rule r join kam.route_template t on t.client_id = r.client_id and t.id = r.template_id and not t.archived
      where r.client_id=$1 and (r.campaign_type_id is null or r.campaign_type_id = $2) and (r.network_group_id is null or r.network_group_id = $3)
      order by r.priority, r.id limit 1`, [clientId, camp.type_id, camp.group_id]);
  if (rows[0]) return { ...rows[0], rule: `правило с приоритетом ${rows[0].priority}` };
  const def = (await q.query<TemplateRow>(`select ${cols} from kam.route_template t where client_id=$1 and is_default`, [clientId])).rows[0];
  if (!def) throw new ApiError(422, 'NO_DEFAULT_ROUTE', 'Не настроен маршрут согласования по умолчанию. Обратитесь к администратору.');
  return { ...def, rule: 'шаблон по умолчанию' };
}

export async function routeCampaign(q: Q, clientId: string, campaignId: string): Promise<RouteCampaign> {
  const c = (await q.query<RouteCampaign>(
    `select c.id, c.owner_id, c.network_id, c.type_id, n.group_id, c.period_from::text period_from, c.period_to::text period_to
       from kam.campaign_with_owner c join kam.network n on n.client_id = c.client_id and n.id = c.network_id where c.client_id=$1 and c.id=$2`, [clientId, campaignId])).rows[0];
  if (!c) throw notFound();
  return c;
}

/** Маршрут для версии кампании: шаблон по правилам, шаги с исполнителями и пропусками. */
export async function computeRoute(q: Q, clientId: string, campaignId: string, versionId: string | null, submitterId: string, template?: TemplateRow & { rule?: string }) {
  const camp = await routeCampaign(q, clientId, campaignId);
  const t = template ?? await selectTemplate(q, clientId, camp);
  const d = await directory(q, clientId);
  const m = versionId ? await versionMetrics(q, clientId, camp, versionId) : null;
  return { template: { id: t.id, name: t.name, rule: t.rule ?? null, tolerance_investment_pct: t.tolerance_investment_pct, tolerance_turnover_pct: t.tolerance_turnover_pct }, steps: resolveSteps(t.steps, camp, m, submitterId, d), metrics: m };
}

// Администрирование шаблонов -------------------------------------------------------

export async function listTemplates(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const d = await directory(ctx.db, ctx.clientId);
  const { rows } = await ctx.db.query<TemplateRow & { description: string; is_default: boolean; revision: number; updated_at: string; in_progress: number }>(
    `select t.id, t.name, t.description, t.is_default, t.steps, t.tolerance_investment_pct::float8 tolerance_investment_pct,
            t.tolerance_turnover_pct::float8 tolerance_turnover_pct, t.revision, t.updated_at,
            (select count(*)::int from kam.approval a where a.client_id = t.client_id and a.template_id = t.id and a.status = 'IN_PROGRESS') in_progress
       from kam.route_template t where t.client_id=$1 and not t.archived order by not t.is_default, t.name`, [ctx.clientId]);
  const { rows: rules } = await ctx.db.query(
    `select r.id, r.priority, r.template_id, r.campaign_type_id, r.network_group_id from kam.route_rule r where r.client_id=$1 order by r.priority, r.id`, [ctx.clientId]);
  return {
    items: rows.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s, assignee_text: assigneeText(s.assignee, d), conditions_text: s.conditions.map((c) => conditionText(c, d)) })) })),
    rules: rules.map((r) => ({ ...r, type_name: r.campaign_type_id ? d.types.get(r.campaign_type_id) : null, group_name: r.network_group_id ? d.groups.get(r.network_group_id) : null })),
  };
}

function templateBody(b: Record<string, unknown>) {
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw required('name', 'Укажите название шаблона.');
  if (name.length > 120) throw invalid('name', 'Не длиннее 120 символов.');
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (description.length > 500) throw invalid('description', 'Не длиннее 500 символов.');
  const tol = (v: unknown, field: string) => {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw invalid(field, 'Допуск — от 0 до 100 %.');
    return Math.round(n * 100) / 100;
  };
  return { name, description, tolerance_investment_pct: tol(b.tolerance_investment_pct, 'tolerance_investment_pct'), tolerance_turnover_pct: tol(b.tolerance_turnover_pct, 'tolerance_turnover_pct'), is_default: Boolean(b.is_default) };
}

export async function saveTemplate(tx: Tx, ctx: Ctx, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const t = templateBody(b);
  const steps = await normalizeSteps(tx, ctx.clientId, b.steps);
  let before: Record<string, unknown> | undefined;
  if (id) {
    if (!isUuid(id)) throw notFound();
    before = (await tx.query('select name, is_default, steps, revision from kam.route_template where client_id=$1 and id=$2 and not archived for update', [ctx.clientId, id])).rows[0];
    if (!before) throw notFound();
    if (b.revision !== undefined && Number(b.revision) !== before.revision) throw new ApiError(412, 'STALE_REVISION', 'Шаблон уже изменили. Обновите страницу и повторите.');
    if (before.is_default && !t.is_default) throw invalid('is_default', 'Шаблон по умолчанию обязателен: назначьте по умолчанию другой шаблон.', 'DEFAULT_REQUIRED');
  }
  const hasDefault = (await tx.query('select 1 from kam.route_template where client_id=$1 and is_default', [ctx.clientId])).rowCount;
  if (!hasDefault && !t.is_default) throw invalid('is_default', 'Первый шаблон клиента становится шаблоном по умолчанию — отметьте его.', 'DEFAULT_REQUIRED');
  if (t.is_default) await tx.query('update kam.route_template set is_default=false where client_id=$1 and is_default and id <> coalesce($2::uuid, gen_random_uuid())', [ctx.clientId, id]);
  const newId = id ?? randomUUID();
  if (id) {
    await tx.query(
      `update kam.route_template set name=$3, description=$4, is_default=$5, steps=$6, tolerance_investment_pct=$7, tolerance_turnover_pct=$8,
              revision = revision + 1, updated_at = now() where client_id=$1 and id=$2`,
      [ctx.clientId, id, t.name, t.description, t.is_default, JSON.stringify(steps), t.tolerance_investment_pct, t.tolerance_turnover_pct]);
  } else {
    await tx.query(
      `insert into kam.route_template(client_id, id, name, description, is_default, steps, tolerance_investment_pct, tolerance_turnover_pct)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientId, newId, t.name, t.description, t.is_default, JSON.stringify(steps), t.tolerance_investment_pct, t.tolerance_turnover_pct]);
  }
  await audit(tx, ctx, { entityType: 'route_template', entityId: newId, action: id ? 'UPDATE' : 'CREATE', before, after: { ...t, steps } });
  return { status: id ? 200 : 201, body: { id: newId } };
}

export async function archiveTemplate(tx: Tx, ctx: Ctx, id: string): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(id)) throw notFound();
  const t = (await tx.query<{ name: string; is_default: boolean }>('select name, is_default from kam.route_template where client_id=$1 and id=$2 and not archived for update', [ctx.clientId, id])).rows[0];
  if (!t) throw notFound();
  if (t.is_default) throw new ApiError(422, 'DEFAULT_REQUIRED', 'Шаблон по умолчанию нельзя удалить: сначала назначьте другой.');
  if ((await tx.query('select 1 from kam.route_rule where client_id=$1 and template_id=$2', [ctx.clientId, id])).rowCount) {
    throw new ApiError(422, 'TEMPLATE_IN_USE', 'Шаблон используется в правилах выбора. Сначала уберите эти правила.');
  }
  await tx.query('update kam.route_template set archived=true, updated_at=now() where client_id=$1 and id=$2', [ctx.clientId, id]);
  await audit(tx, ctx, { entityType: 'route_template', entityId: id, action: 'ARCHIVE', before: { name: t.name } });
  return { status: 200, body: { id } };
}

/** Правила выбора заменяются целиком: порядок строк = приоритет. */
export async function saveRules(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!Array.isArray(b.rules) || b.rules.length > 50) throw invalid('rules', 'Передайте список правил (не больше 50).');
  const d = await directory(tx, ctx.clientId);
  const templates = new Set((await tx.query<{ id: string }>('select id from kam.route_template where client_id=$1 and not archived', [ctx.clientId])).rows.map((r) => r.id));
  const rules = (b.rules as Record<string, unknown>[]).map((r, i) => {
    const at = `Правило ${i + 1}: `;
    if (!isUuid(r?.template_id) || !templates.has(r.template_id)) throw invalid('rules', at + 'выберите шаблон.');
    const type = r.campaign_type_id ?? null;
    const group = r.network_group_id ?? null;
    if (type !== null && (!isUuid(type) || !d.types.has(type))) throw invalid('rules', at + 'тип кампании не найден.');
    if (group !== null && (!isUuid(group) || !d.groups.has(group))) throw invalid('rules', at + 'группа сетей не найдена.');
    if (type === null && group === null) throw invalid('rules', at + 'укажите тип кампании или группу сетей.');
    return { template_id: r.template_id as string, campaign_type_id: type as string | null, network_group_id: group as string | null, priority: (i + 1) * 10 };
  });
  const before = (await tx.query('select priority, template_id, campaign_type_id, network_group_id from kam.route_rule where client_id=$1 order by priority', [ctx.clientId])).rows;
  await tx.query('delete from kam.route_rule where client_id=$1', [ctx.clientId]);
  for (const r of rules) {
    await tx.query('insert into kam.route_rule(client_id, id, priority, template_id, campaign_type_id, network_group_id) values ($1,$2,$3,$4,$5,$6)',
      [ctx.clientId, randomUUID(), r.priority, r.template_id, r.campaign_type_id, r.network_group_id]);
  }
  await audit(tx, ctx, { entityType: 'route_rule', action: 'REPLACE', before, after: rules });
  return { status: 200, body: { rules: rules.length } };
}

/** Предпросмотр: несохранённый или сохранённый шаблон на выбранной кампании (текущая версия, автор — ответственный). */
export async function previewTemplate(ctx: Ctx, b: Record<string, unknown>) {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(b.campaign_id)) throw required('campaign_id', 'Выберите кампанию.');
  const vis = campaignVisibility(ctx, 3);
  const c = (await ctx.db.query<{ owner_id: string | null; title: string; network: string }>(
    `select c.owner_id, c.title, n.name network from kam.campaign_with_owner c join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where c.client_id=$1 and c.id=$2 and ${vis.sql}`, [ctx.clientId, b.campaign_id, ...vis.params])).rows[0];
  if (!c) throw notFound();
  if (!c.owner_id) throw new ApiError(422, 'NETWORK_NOT_ASSIGNED', 'Сначала закрепите аптечную сеть за КАМом.');
  const v = (await ctx.db.query<{ id: string }>('select id from kam.offer_version where client_id=$1 and campaign_id=$2 order by number desc limit 1', [ctx.clientId, b.campaign_id])).rows[0];
  let template: (TemplateRow & { rule?: string }) | undefined;
  if (b.steps !== undefined) {
    template = { id: '', name: typeof b.name === 'string' ? b.name : 'Новый шаблон', steps: await normalizeSteps(ctx.db, ctx.clientId, b.steps), tolerance_investment_pct: 0, tolerance_turnover_pct: 0, rule: 'предпросмотр' };
  }
  const r = await computeRoute(ctx.db, ctx.clientId, b.campaign_id, v?.id ?? null, c.owner_id, template);
  return { campaign: { id: b.campaign_id, title: c.title, network: c.network }, has_version: Boolean(v), ...r };
}

/** Роль нельзя убрать из согласующих, пока она стоит в шаге шаблона. */
export async function ensureRoleNotInRoutes(q: Q, clientId: string, roleId: string) {
  const { rows } = await q.query<{ name: string }>(
    `select t.name from kam.route_template t where t.client_id=$1 and not t.archived
        and exists (select 1 from jsonb_array_elements(t.steps) s where s->'assignee'->>'role_id' = $2::text)`, [clientId, roleId]);
  if (rows.length) throw new ApiError(422, 'ROLE_IN_ROUTE', `Роль используется в маршрутах: ${rows.map((r) => `«${r.name}»`).join(', ')}. Сначала уберите её из шагов.`);
}
