// Согласование кампании (ТЗ §4–5): отправка с заморозкой маршрута, отзыв, решения, «Мои решения», замещения.

import { randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { ApiError, forbidden, invalid, notFound, required } from './errors.js';
import { type Ctx, campaignVisibility, canEditFor, requirePermission } from './access.js';
import { type CommandResult, audit, bumpCampaign, campaignEtag, campaignEvent, isUuid, lockCampaign } from './commands.js';
import { canSee, computeRoute, directory, fmtMoney } from './routes.js';
import { notify } from './notify.js';

type Q = Pick<Tx, 'query'>;

/** Срок решения: N рабочих дней (пн–пт) от даты начала шага. */
export function addWorkdays(iso: string, n: number): string {
  let t = Date.parse(iso + 'T00:00:00Z');
  let left = n;
  while (left > 0) {
    t += 86400_000;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

const today = async (q: Q) => (await q.query<{ d: string }>('select current_date::text d')).rows[0]!.d;

async function visibleCampaign(q: Q, ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const vis = campaignVisibility(ctx, 3);
  const c = (await q.query<{ id: string; stage: string; owner_id: string | null; revision: number }>(
    `select c.id, c.stage, c.owner_id, c.revision from kam.campaign_with_owner c where c.client_id=$1 and c.id=$2 and ${vis.sql}`,
    [ctx.clientId, id, ...vis.params])).rows[0];
  if (!c) throw notFound();
  return c;
}

async function latestVersion(q: Q, clientId: string, campaignId: string) {
  return (await q.query<{ id: string; number: number; justification: string; investment: number; turnover: number }>(
    `select id, number, justification, total_investment::float8 investment, total_turnover::float8 turnover
       from kam.offer_version where client_id=$1 and campaign_id=$2 order by number desc limit 1`, [clientId, campaignId])).rows[0];
}

async function versionRejected(q: Q, clientId: string, versionId: string) {
  return Boolean((await q.query("select 1 from kam.approval where client_id=$1 and version_id=$2 and status='REJECTED'", [clientId, versionId])).rowCount);
}

async function activeApproval(q: Q, clientId: string, campaignId: string) {
  return (await q.query<{ id: string; round: number; submitted_by: string; version_id: string }>(
    "select id, round, submitted_by, version_id from kam.approval where client_id=$1 and campaign_id=$2 and status='IN_PROGRESS' for update",
    [clientId, campaignId])).rows[0];
}

async function setStage(tx: Tx, ctx: Ctx, id: string, from: string, to: string, comment: string | null) {
  await tx.query('update kam.campaign set stage=$3, stage_changed_at=now() where client_id=$1 and id=$2', [ctx.clientId, id, to]);
  await campaignEvent(tx, ctx, id, 'STAGE', { from, to, comment });
}

/** Закрывает идущее согласование (отмена кампании, новая версия вне допусков). */
export async function closeApproval(tx: Tx, clientId: string, campaignId: string, status: 'CANCELLED' | 'SUPERSEDED' | 'WITHDRAWN') {
  const a = await activeApproval(tx, clientId, campaignId);
  if (!a) return null;
  await tx.query("update kam.approval set status=$3, finished_at=now() where client_id=$1 and id=$2", [clientId, a.id, status]);
  await tx.query("update kam.approval_step set status='CANCELLED' where client_id=$1 and approval_id=$2 and status in ('ACTIVE','WAITING')", [clientId, a.id]);
  return a;
}

// Уведомления ----------------------------------------------------------------------

async function campaignLabel(q: Q, clientId: string, id: string) {
  const r = (await q.query<{ title: string; network: string; owner_id: string | null }>(
    'select c.title, n.name network, c.owner_id from kam.campaign_with_owner c join kam.network n on n.client_id = c.client_id and n.id = c.network_id where c.client_id=$1 and c.id=$2', [clientId, id])).rows[0]!;
  return { ...r, label: `${r.network} — ${r.title}` };
}

/** Исполнители шага и их заместители на сегодня. */
async function withDeputies(q: Q, clientId: string, users: string[]) {
  const { rows } = await q.query<{ d: string }>('select deputy_id d from kam.substitution where client_id=$1 and user_id = any($2::uuid[]) and valid @> current_date', [clientId, users]);
  return [...users, ...rows.map((r) => r.d)];
}

async function notifyStep(q: Q, ctx: Ctx, campaignId: string, step: { title: string; candidates: string[]; due: string | null }) {
  const c = await campaignLabel(q, ctx.clientId, campaignId);
  await notify(q, ctx.clientId, { kind: 'STEP_ASSIGNED', users: await withDeputies(q, ctx.clientId, step.candidates), campaignId, actorId: ctx.principal.userId,
    title: `Нужно ваше решение: ${c.label}`, body: `Шаг «${step.title}»${step.due ? `, срок — ${step.due.split('-').reverse().join('.')}` : ''}.` });
}

/** Новая версия согласованной кампании: уведомить согласовавших. */
export async function notifyVersionChanged(q: Q, ctx: Ctx, campaignId: string, number: number, reason: string) {
  const { rows } = await q.query<{ u: string }>(
    `select distinct s.decided_by u from kam.approval a join kam.approval_step s on s.client_id = a.client_id and s.approval_id = a.id and s.status='APPROVED'
      where a.client_id=$1 and a.campaign_id=$2 and a.round = (select max(round) from kam.approval where client_id=$1 and campaign_id=$2 and status in ('APPROVED','SUPERSEDED'))`,
    [ctx.clientId, campaignId]);
  const c = await campaignLabel(q, ctx.clientId, campaignId);
  await notify(q, ctx.clientId, { kind: 'VERSION_CHANGED', users: rows.map((r) => r.u), campaignId, actorId: ctx.principal.userId, title: `Версия ${number}: ${c.label}`, body: reason });
}

// Отправка --------------------------------------------------------------------

export async function submit(tx: Tx, ctx: Ctx, campaignId: string, ifMatch: string | undefined, b: Record<string, unknown>): Promise<CommandResult> {
  const locked = await lockCampaign(tx, ctx, campaignId, ifMatch);
  await visibleCampaign(tx, ctx, campaignId);
  if (!canEditFor(ctx, locked.owner_id)) throw forbidden();
  if (locked.stage !== 'NEGOTIATION') throw new ApiError(409, 'TRANSITION_NOT_ALLOWED', 'Отправить на согласование можно с этапа «Переговоры с сетью».', { stage: locked.stage });
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 2000) throw invalid('comment', 'Не длиннее 2000 символов.');
  const v = await latestVersion(tx, ctx.clientId, campaignId);
  if (!v) throw new ApiError(422, 'VERSION_REQUIRED', 'Сначала добавьте версию предложения с разбивкой по брендам.');
  if (!v.justification.trim()) throw new ApiError(422, 'JUSTIFICATION_REQUIRED', `Заполните обоснование в версии ${v.number}: создайте новую версию с обоснованием.`);
  if (!(v.investment > 0 || v.turnover > 0)) throw new ApiError(422, 'EMPTY_BREAKDOWN', 'Разбивка версии пустая.');
  if (await versionRejected(tx, ctx.clientId, v.id)) throw new ApiError(422, 'VERSION_REJECTED', `Версию ${v.number} уже отклонили. Повторная отправка — только с новой версией.`);
  const route = await computeRoute(tx, ctx.clientId, campaignId, v.id, ctx.principal.userId);
  const broken = route.steps.filter((s) => s.included && s.error);
  if (broken.length) {
    throw new ApiError(422, 'NO_ASSIGNEE', `Не удалось определить исполнителя: ${broken.map((s) => `шаг ${s.position} «${s.title}» — ${s.error}`).join(' ')}`, { steps: broken });
  }
  const round = (await tx.query<{ n: number }>('select coalesce(max(round),0)::int + 1 n from kam.approval where client_id=$1 and campaign_id=$2', [ctx.clientId, campaignId])).rows[0]!.n;
  const approvalId = randomUUID();
  const included = route.steps.filter((s) => s.included);
  const done = included.length === 0;
  await tx.query(
    `insert into kam.approval(client_id, id, campaign_id, version_id, round, template_id, template_name, status, submitted_by, submit_comment,
                              total_investment, total_turnover, tolerance_investment_pct, tolerance_turnover_pct, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, case when $8 = 'APPROVED' then now() end)`,
    [ctx.clientId, approvalId, campaignId, v.id, round, route.template.id, route.template.name, done ? 'APPROVED' : 'IN_PROGRESS', ctx.principal.userId, comment,
      v.investment, v.turnover, route.template.tolerance_investment_pct, route.template.tolerance_turnover_pct]);
  const day = await today(tx);
  const firstActive = included[0]?.position;
  for (const s of route.steps) {
    const status = !s.included ? 'SKIPPED' : s.position === firstActive ? 'ACTIVE' : 'WAITING';
    await tx.query(
      `insert into kam.approval_step(client_id, id, approval_id, campaign_id, position, title, assignee_rule, condition_text, status, skip_reason,
                                     candidates, assign_note, deadline_days, activated_at, due_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, case when $9='ACTIVE' then now() end, $14)`,
      [ctx.clientId, randomUUID(), approvalId, campaignId, s.position, s.title, s.assignee_rule, s.condition_text, status, s.skip_reason,
        s.candidates.map((x) => x.id), s.assign_note, s.deadline_days, status === 'ACTIVE' ? addWorkdays(day, s.deadline_days) : null]);
  }
  const first = included[0];
  if (first) await notifyStep(tx, ctx, campaignId, { title: first.title, candidates: first.candidates.map((x) => x.id), due: addWorkdays(day, first.deadline_days) });
  const to = done ? 'APPROVED' : 'APPROVAL';
  await tx.query('update kam.campaign set stage=$3, stage_changed_at=now() where client_id=$1 and id=$2', [ctx.clientId, campaignId, to]);
  await campaignEvent(tx, ctx, campaignId, 'APPROVAL_SUBMITTED', { comment: comment || null, payload: { round, version: v.number, template: route.template.name, steps: included.length, skipped: route.steps.length - included.length } });
  await campaignEvent(tx, ctx, campaignId, 'STAGE', { from: 'NEGOTIATION', to: 'APPROVAL' });
  if (done) await campaignEvent(tx, ctx, campaignId, 'STAGE', { from: 'APPROVAL', to: 'APPROVED', comment: 'Все шаги маршрута пропущены по условиям.' });
  const rev = await bumpCampaign(tx, ctx, campaignId);
  await audit(tx, ctx, { entityType: 'approval', entityId: approvalId, action: 'SUBMIT', after: { campaign_id: campaignId, round, version: v.number, template: route.template.name, steps: route.steps.map((s) => ({ title: s.title, included: s.included, candidates: s.candidates.map((x) => x.name) })) } });
  return { status: 201, body: { id: approvalId, round, stage: to, revision: rev }, etag: campaignEtag(campaignId, rev) };
}

export async function withdraw(tx: Tx, ctx: Ctx, campaignId: string, ifMatch: string | undefined, b: Record<string, unknown>): Promise<CommandResult> {
  const locked = await lockCampaign(tx, ctx, campaignId, ifMatch);
  await visibleCampaign(tx, ctx, campaignId);
  if (!canEditFor(ctx, locked.owner_id)) throw forbidden();
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 2000) throw invalid('comment', 'Не длиннее 2000 символов.');
  const a = locked.stage === 'APPROVAL' ? await activeApproval(tx, ctx.clientId, campaignId) : undefined;
  if (!a) throw new ApiError(409, 'TRANSITION_NOT_ALLOWED', 'Кампания не на согласовании.');
  const decided = (await tx.query("select 1 from kam.approval_step where client_id=$1 and approval_id=$2 and status='APPROVED'", [ctx.clientId, a.id])).rowCount;
  if (decided) throw new ApiError(409, 'ALREADY_DECIDED', 'Отозвать можно только до первого решения согласующих.');
  await closeApproval(tx, ctx.clientId, campaignId, 'WITHDRAWN');
  await campaignEvent(tx, ctx, campaignId, 'APPROVAL_WITHDRAWN', { comment: comment || null, payload: { round: a.round } });
  await setStage(tx, ctx, campaignId, 'APPROVAL', 'NEGOTIATION', null);
  const rev = await bumpCampaign(tx, ctx, campaignId);
  await audit(tx, ctx, { entityType: 'approval', entityId: a.id, action: 'WITHDRAW', reason: comment || null });
  return { status: 200, body: { stage: 'NEGOTIATION', revision: rev }, etag: campaignEtag(campaignId, rev) };
}

// Решения ----------------------------------------------------------------------

/** За кого пользователь может решить шаг: сам или как заместитель кандидата на сегодня. */
async function decisionRight(q: Q, ctx: Ctx, candidates: string[], owner: string | null): Promise<{ ok: boolean; forUser: string | null }> {
  const eligible = candidates.filter((id) => id !== owner);
  if (eligible.includes(ctx.principal.userId)) return { ok: true, forUser: null };
  const { rows } = await q.query<{ user_id: string }>(
    `select user_id from kam.substitution where client_id=$1 and deputy_id=$2 and valid @> current_date and user_id = any($3::uuid[]) order by user_id limit 1`,
    [ctx.clientId, ctx.principal.userId, eligible]);
  return rows[0] ? { ok: true, forUser: rows[0].user_id } : { ok: false, forUser: null };
}

export async function decide(tx: Tx, ctx: Ctx, campaignId: string, ifMatch: string | undefined, b: Record<string, unknown>): Promise<CommandResult> {
  const locked = await lockCampaign(tx, ctx, campaignId, ifMatch);
  await visibleCampaign(tx, ctx, campaignId);
  const decision = b.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw invalid('decision', 'Выберите «Согласовать» или «Отклонить».');
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 2000) throw invalid('comment', 'Не длиннее 2000 символов.');
  if (decision === 'REJECT' && !comment) throw required('comment', 'Напишите, что нужно изменить: без комментария отклонить нельзя.');
  const a = locked.stage === 'APPROVAL' ? await activeApproval(tx, ctx.clientId, campaignId) : undefined;
  if (!a) throw new ApiError(409, 'NOT_IN_APPROVAL', 'Кампания не на согласовании.');
  const step = (await tx.query<{ id: string; position: number; title: string; candidates: string[] }>(
    "select id, position, title, candidates from kam.approval_step where client_id=$1 and approval_id=$2 and status='ACTIVE' for update", [ctx.clientId, a.id])).rows[0];
  if (!step || (b.step_id !== undefined && b.step_id !== step.id)) throw new ApiError(409, 'STEP_NOT_ACTIVE', 'Этот шаг уже решён. Обновите карточку.');
  if (ctx.principal.userId === a.submitted_by || ctx.principal.userId === locked.owner_id) throw new ApiError(403, 'SELF_APPROVAL', 'Нельзя согласовывать собственную кампанию.');
  const right = await decisionRight(tx, ctx, step.candidates, locked.owner_id);
  if (!right.ok) throw forbidden('Вы не исполнитель этого шага и не замещаете его исполнителя.');
  await tx.query(
    `update kam.approval_step set status=$3, decided_by=$4, decided_for=$5, decision_comment=$6, decided_at=now() where client_id=$1 and id=$2`,
    [ctx.clientId, step.id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', ctx.principal.userId, right.forUser, comment || null]);
  const forName = right.forUser ? (await tx.query<{ n: string }>('select display_name n from kam.employee_profile where client_id=$1 and id=$2', [ctx.clientId, right.forUser])).rows[0]?.n ?? null : null;
  await campaignEvent(tx, ctx, campaignId, 'APPROVAL_DECISION', { comment: comment || null, payload: { round: a.round, step: step.position, title: step.title, decision, for_user: right.forUser, for_user_name: forName } });
  const c = await campaignLabel(tx, ctx.clientId, campaignId);
  const recipients = [c.owner_id];
  if (a.submitted_by !== c.owner_id) {
    const d = await directory(tx, ctx.clientId);
    const sender = d.users.get(a.submitted_by);
    if (sender && canSee(sender, c, d)) recipients.push(sender.id);
  }
  let stage = 'APPROVAL';
  if (decision === 'REJECT') {
    await tx.query("update kam.approval set status='REJECTED', finished_at=now() where client_id=$1 and id=$2", [ctx.clientId, a.id]);
    await tx.query("update kam.approval_step set status='CANCELLED' where client_id=$1 and approval_id=$2 and status='WAITING'", [ctx.clientId, a.id]);
    stage = 'NEGOTIATION';
    await setStage(tx, ctx, campaignId, 'APPROVAL', stage, `Отклонено на шаге «${step.title}»: ${comment}`);
    await notify(tx, ctx.clientId, { kind: 'RETURNED', users: recipients, campaignId, actorId: ctx.principal.userId,
      title: `Возвращено на доработку: ${c.label}`, body: `${ctx.principal.displayName}, шаг «${step.title}»: ${comment}` });
  } else {
    const next = (await tx.query<{ id: string; deadline_days: number; title: string; candidates: string[] }>(
      "select id, deadline_days, title, candidates from kam.approval_step where client_id=$1 and approval_id=$2 and status='WAITING' order by position limit 1", [ctx.clientId, a.id])).rows[0];
    if (next) {
      const due = addWorkdays(await today(tx), next.deadline_days);
      await tx.query("update kam.approval_step set status='ACTIVE', activated_at=now(), due_date=$3 where client_id=$1 and id=$2", [ctx.clientId, next.id, due]);
      await notifyStep(tx, ctx, campaignId, { title: next.title, candidates: next.candidates, due });
      await notify(tx, ctx.clientId, { kind: 'DECISION', users: recipients, campaignId, actorId: ctx.principal.userId,
        title: `Шаг «${step.title}» согласован: ${c.label}`, body: `${ctx.principal.displayName}${forName ? ` за ${forName}` : ''}${comment ? `: ${comment}` : ''}. Следующий шаг — «${next.title}».` });
    } else {
      await tx.query("update kam.approval set status='APPROVED', finished_at=now() where client_id=$1 and id=$2", [ctx.clientId, a.id]);
      stage = 'APPROVED';
      await setStage(tx, ctx, campaignId, 'APPROVAL', stage, 'Все шаги маршрута согласованы.');
      await notify(tx, ctx.clientId, { kind: 'APPROVED', users: recipients, campaignId, actorId: ctx.principal.userId,
        title: `Согласовано внутри: ${c.label}`, body: 'Все шаги маршрута пройдены. Следующий этап — подтверждение сетью.' });
    }
  }
  const rev = await bumpCampaign(tx, ctx, campaignId);
  await audit(tx, ctx, { entityType: 'approval', entityId: a.id, action: decision, reason: comment || null, after: { step: step.position, title: step.title, for_user: right.forUser } });
  return { status: 200, body: { stage, revision: rev }, etag: campaignEtag(campaignId, rev) };
}

// Новая версия после «Согласовано внутри» -------------------------------------------

/** Возвращает null, если версия в допусках (этап сохраняется), иначе текст причины возврата в переговоры. */
export async function checkTolerance(q: Q, clientId: string, campaignId: string, inv: number, turn: number): Promise<{ within: boolean; reason: string }> {
  const a = (await q.query<{ inv: number; turn: number; ti: number; tt: number }>(
    `select total_investment::float8 inv, total_turnover::float8 turn, tolerance_investment_pct::float8 ti, tolerance_turnover_pct::float8 tt
       from kam.approval where client_id=$1 and campaign_id=$2 and status='APPROVED' order by round desc limit 1`, [clientId, campaignId])).rows[0];
  if (!a) return { within: false, reason: 'Нет согласованной версии для сравнения.' };
  const invLimit = a.inv * (1 + a.ti / 100);
  const turnLimit = a.turn * (1 - a.tt / 100);
  const issues: string[] = [];
  if (inv > invLimit + 0.005) issues.push(`инвестиции ${fmtMoney(inv)} больше согласованных ${fmtMoney(a.inv)}${a.ti ? ` с допуском ${a.ti} %` : ''}`);
  if (turn < turnLimit - 0.005) issues.push(`оборот ${fmtMoney(turn)} меньше согласованного ${fmtMoney(a.turn)}${a.tt ? ` с допуском ${a.tt} %` : ''}`);
  return issues.length
    ? { within: false, reason: `Новая версия вне допусков согласования: ${issues.join('; ')}. Нужна повторная отправка.` }
    : { within: true, reason: 'Новая версия в пределах допусков — согласование сохраняется.' };
}

// Чтение ------------------------------------------------------------------------

export async function getApproval(ctx: Ctx, campaignId: string) {
  const c = await visibleCampaign(ctx.db, ctx, campaignId);
  const { rows: rounds } = await ctx.db.query(
    `select a.id, a.round, a.status, a.template_name, a.submitted_at, a.finished_at, a.submit_comment, a.submitted_by, su.display_name submitted_by_name,
            v.number version, a.total_investment::float8 investment, a.total_turnover::float8 turnover,
            a.tolerance_investment_pct::float8 tolerance_investment_pct, a.tolerance_turnover_pct::float8 tolerance_turnover_pct
       from kam.approval a join kam.offer_version v on v.client_id = a.client_id and v.id = a.version_id join kam.employee_profile su on su.client_id = a.client_id and su.id = a.submitted_by
      where a.client_id=$1 and a.campaign_id=$2 order by a.round desc`, [ctx.clientId, campaignId]);
  const { rows: steps } = await ctx.db.query(
    `select s.approval_id, s.id, s.position, s.title, s.assignee_rule, s.condition_text, s.status, s.skip_reason, s.assign_note, s.deadline_days,
            s.activated_at, s.due_date::text due_date, s.decided_at, s.decision_comment, s.candidates,
            db.display_name decided_by_name, df.display_name decided_for_name,
            coalesce((select json_agg(json_build_object('id', u.id, 'name', u.display_name) order by u.display_name) from kam.employee_profile u where u.client_id = s.client_id and u.id = any(s.candidates)), '[]') candidate_users,
            coalesce((select json_agg(json_build_object('user', u.display_name, 'deputy', d.display_name, 'to', (upper(sb.valid) - 1)::text))
                        from kam.substitution sb join kam.employee_profile u on u.client_id = sb.client_id and u.id = sb.user_id join kam.employee_profile d on d.client_id = sb.client_id and d.id = sb.deputy_id
                       where sb.client_id = s.client_id and sb.user_id = any(s.candidates) and sb.valid @> current_date), '[]') deputies
       from kam.approval_step s left join kam.employee_profile db on db.client_id = s.client_id and db.id = s.decided_by left join kam.employee_profile df on df.client_id = s.client_id and df.id = s.decided_for
      where s.client_id=$1 and s.campaign_id=$2 order by s.position`, [ctx.clientId, campaignId]);
  const day = await today(ctx.db);
  const byRound = rounds.map((r) => ({
    ...r,
    steps: steps.filter((s) => s.approval_id === r.id).map(({ approval_id: _a, candidates: _c, ...s }) => ({ ...s, overdue: s.status === 'ACTIVE' && s.due_date < day })),
  }));
  const current = byRound.find((r) => r.status === 'IN_PROGRESS') ?? null;
  let my: { step_id: string; for_user: string | null } | null = null;
  if (current && ctx.principal.userId !== current.submitted_by && ctx.principal.userId !== c.owner_id) {
    const active = steps.find((s) => s.approval_id === current.id && s.status === 'ACTIVE');
    if (active) {
      const right = await decisionRight(ctx.db, ctx, active.candidates, c.owner_id);
      if (right.ok) {
        const name = right.forUser ? (await ctx.db.query<{ n: string }>('select display_name n from kam.employee_profile where client_id=$1 and id=$2', [ctx.clientId, right.forUser])).rows[0]?.n ?? null : null;
        my = { step_id: active.id, for_user: name };
      }
    }
  }
  const edit = canEditFor(ctx, c.owner_id);
  const canWithdraw = Boolean(current && edit && !current.steps.some((s: { status: string }) => s.status === 'APPROVED'));
  // Предпросмотр маршрута до отправки: КАМ видит, к кому уйдёт кампания.
  let preview = null;
  if (edit && c.stage === 'NEGOTIATION') {
    const v = await latestVersion(ctx.db, ctx.clientId, campaignId);
    try {
      const r = await computeRoute(ctx.db, ctx.clientId, campaignId, v?.id ?? null, ctx.principal.userId);
      preview = {
        template: r.template, steps: r.steps,
        version: v?.number ?? null,
        problems: [
          ...(!v ? ['Нет версии предложения.'] : []),
          ...(v && !v.justification.trim() ? [`В версии ${v.number} не заполнено обоснование.`] : []),
          ...(v && await versionRejected(ctx.db, ctx.clientId, v.id) ? [`Версию ${v.number} отклонили — нужна новая версия.`] : []),
          ...r.steps.filter((s) => s.included && s.error).map((s) => `Шаг «${s.title}»: ${s.error}`),
        ],
      };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      preview = { template: null, steps: [], version: v?.number ?? null, problems: [e.message] };
    }
  }
  return { rounds: byRound, current, my_decision: my, can_withdraw: canWithdraw, preview };
}

const pendingForUser = `s.status = 'ACTIVE' and a.submitted_by <> $2 and c.owner_id is distinct from $2
  and (s.candidates @> array[$2::uuid] or exists (select 1 from kam.substitution sb
       where sb.client_id = s.client_id and sb.deputy_id = $2 and sb.valid @> current_date
         and sb.user_id is distinct from c.owner_id and sb.user_id = any(s.candidates)))`;

export async function myDecisions(ctx: Ctx, status: string | undefined) {
  const done = status === 'done';
  const params: unknown[] = [ctx.clientId, ctx.principal.userId];
  const who = done ? 's.decided_by = $2' : pendingForUser;
  const { rows } = await ctx.db.query(
    `select s.id step_id, s.title step_title, s.position, s.status, s.activated_at, s.due_date::text due_date, s.decided_at, s.decision_comment,
            (s.status = 'ACTIVE' and s.due_date < current_date) overdue,
            (select count(*)::int from kam.approval_step x where x.client_id = s.client_id and x.approval_id = s.approval_id and x.status <> 'SKIPPED') steps_total,
            c.id campaign_id, c.number, c.title, c.period_from, c.period_to, c.stage, n.name network, t.name type_name, coalesce(ow.display_name, 'КАМ не назначен') owner,
            a.round, a.total_investment::float8 investment, a.total_turnover::float8 turnover, v.number version, sub.display_name submitted_by,
            df.display_name decided_for,
            (case when not (s.candidates @> array[$2::uuid]) then (select string_agg(u.display_name, ', ') from kam.substitution sb join kam.employee_profile u on u.client_id = sb.client_id and u.id = sb.user_id
               where sb.client_id = s.client_id and sb.deputy_id = $2 and sb.valid @> current_date and sb.user_id is distinct from c.owner_id and sb.user_id = any(s.candidates)) end) on_behalf_of
       from kam.approval_step s
       join kam.approval a on a.client_id = s.client_id and a.id = s.approval_id
       join kam.offer_version v on v.client_id = a.client_id and v.id = a.version_id
       join kam.campaign_with_owner c on c.client_id = s.client_id and c.id = s.campaign_id
       join kam.network n on n.client_id = c.client_id and n.id = c.network_id
       join kam.campaign_type t on t.client_id = c.client_id and t.id = c.type_id
       left join kam.employee_profile ow on ow.client_id = c.client_id and ow.id = c.owner_id
       join kam.employee_profile sub on sub.client_id = a.client_id and sub.id = a.submitted_by
       left join kam.employee_profile df on df.client_id = s.client_id and df.id = s.decided_for
      where s.client_id = $1 and ${who}
      order by ${done ? 's.decided_at desc' : 's.due_date, s.activated_at'} limit 200`, params);
  return {
    items: rows.map((r) => ({ ...r, roi: r.investment > 0 ? Math.round((r.turnover / r.investment) * 100) / 100 : null })),
    pending: done ? undefined : rows.length,
  };
}

export async function pendingCount(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    `select count(*)::int n from kam.approval_step s join kam.approval a on a.client_id = s.client_id and a.id = s.approval_id
       join kam.campaign_with_owner c on c.client_id = s.client_id and c.id = s.campaign_id
      where s.client_id=$1 and ${pendingForUser}`, [ctx.clientId, ctx.principal.userId]);
  return rows[0]!.n;
}

// Замещения ----------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listSubstitutions(ctx: Ctx) {
  const all = ctx.access.permissions.has('ADMIN');
  const { rows } = await ctx.db.query(
    `select s.id, s.user_id, u.display_name user_name, s.deputy_id, d.display_name deputy_name, lower(s.valid)::text "from", (upper(s.valid) - 1)::text "to",
            s.comment, (s.valid @> current_date) active, (upper(s.valid) <= current_date) past
       from kam.substitution s join kam.employee_profile u on u.client_id = s.client_id and u.id = s.user_id join kam.employee_profile d on d.client_id = s.client_id and d.id = s.deputy_id
      where s.client_id=$1 and ($2 or s.user_id = $3 or s.deputy_id = $3) and upper(s.valid) > current_date - 30
      order by lower(s.valid) desc`, [ctx.clientId, all, ctx.principal.userId]);
  const { rows: people } = await ctx.db.query(
    `select u.id, u.display_name name from kam.employee_profile u
      where u.client_id=$1 and u.active and not u.disabled order by u.display_name`, [ctx.clientId]);
  return { items: rows, people, can_manage_all: all };
}

export async function createSubstitution(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  const userId = (b.user_id ?? ctx.principal.userId) as string;
  if (!isUuid(userId)) throw invalid('user_id', 'Выберите сотрудника.');
  if (userId !== ctx.principal.userId) requirePermission(ctx, 'ADMIN');
  if (!isUuid(b.deputy_id)) throw required('deputy_id', 'Выберите заместителя.');
  if (b.deputy_id === userId) throw invalid('deputy_id', 'Заместитель — другой сотрудник.');
  const active = (await tx.query("select 1 from kam.membership m join kam.app_user u on u.id = m.user_id and not u.disabled where m.client_id=$1 and m.user_id=$2 and m.active", [ctx.clientId, b.deputy_id])).rowCount;
  if (!active) throw invalid('deputy_id', 'Заместитель не найден или отключён.');
  const from = b.from, to = b.to;
  if (typeof from !== 'string' || !DATE.test(from)) throw invalid('from', 'Укажите дату начала.');
  if (typeof to !== 'string' || !DATE.test(to)) throw invalid('to', 'Укажите дату окончания.');
  if (to < from) throw invalid('to', 'Окончание раньше начала.');
  if (to < await today(tx)) throw invalid('to', 'Период замещения уже прошёл.');
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 500) throw invalid('comment', 'Не длиннее 500 символов.');
  const id = randomUUID();
  try {
    await tx.query(`insert into kam.substitution(client_id, id, user_id, deputy_id, valid, comment, created_by) values ($1,$2,$3,$4, daterange($5::date, $6::date, '[]'), $7, $8)`,
      [ctx.clientId, id, userId, b.deputy_id, from, to, comment, ctx.principal.userId]);
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') throw new ApiError(422, 'PERIOD_OVERLAP', 'У сотрудника уже есть замещение на эти даты.', {}, 'from');
    throw e;
  }
  await audit(tx, ctx, { entityType: 'substitution', entityId: id, action: 'CREATE', after: { user_id: userId, deputy_id: b.deputy_id, from, to, comment } });
  return { status: 201, body: { id } };
}

export async function deleteSubstitution(tx: Tx, ctx: Ctx, id: string): Promise<CommandResult> {
  if (!isUuid(id)) throw notFound();
  const s = (await tx.query<{ user_id: string; deputy_id: string; from: string; to: string; started: boolean }>(
    `select user_id, deputy_id, lower(valid)::text "from", (upper(valid) - 1)::text "to", lower(valid) < current_date started
       from kam.substitution where client_id=$1 and id=$2 for update`, [ctx.clientId, id])).rows[0];
  if (!s) throw notFound();
  if (s.user_id !== ctx.principal.userId) requirePermission(ctx, 'ADMIN');
  // Начавшееся замещение не удаляется, а завершается вчерашним днём: решения заместителя остаются объяснимыми.
  if (s.started) {
    await tx.query(`update kam.substitution set valid = daterange(lower(valid), current_date, '[)') where client_id=$1 and id=$2`, [ctx.clientId, id]);
  } else {
    await tx.query('delete from kam.substitution where client_id=$1 and id=$2', [ctx.clientId, id]);
  }
  await audit(tx, ctx, { entityType: 'substitution', entityId: id, action: 'END', before: s });
  return { status: 200, body: { id } };
}
