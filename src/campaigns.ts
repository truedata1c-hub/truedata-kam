// Кампании и портфель (ТЗ §4). Шаг 1: создание, правка реквизитов, юрлица, переход в переговоры, отмена, история.
// Версии, согласование и подтверждение сетью добавляются на шагах 2–4.

import { randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { ApiError, forbidden, invalid, notFound, required } from './errors.js';
import { type Ctx, campaignVisibility, canEditFor, isAssigned } from './access.js';
import { type CommandResult, audit, bumpCampaign, campaignEtag, campaignEvent, isUuid, lockCampaign } from './commands.js';
import { closeApproval } from './approval.js';
import { notify } from './notify.js';

export const STAGES = ['PREPARATION', 'NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL', 'CANCELLED', 'CLOSED'] as const;
export type Stage = (typeof STAGES)[number];
export const OPEN_STAGES: Stage[] = ['PREPARATION', 'NEGOTIATION', 'APPROVAL'];
const EDITABLE_STAGES: Stage[] = ['PREPARATION', 'NEGOTIATION'];
const CANCELLABLE: Stage[] = ['PREPARATION', 'NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateField(v: unknown, field: string, optional = false): string | null {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw invalid(field, 'Укажите дату в формате ГГГГ-ММ-ДД.');
  return v;
}
function textField(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw required(field);
  if (s.length > max) throw invalid(field, `Не длиннее ${max} символов.`);
  return s;
}
const addDays = (iso: string, days: number) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);

// Портфель ------------------------------------------------------------------

export interface ListQuery {
  year?: string; stage?: string; type?: string; network?: string; owner?: string; q?: string; overdue?: string; group?: string;
}

export async function listCampaigns(ctx: Ctx, q: ListQuery) {
  const vis = campaignVisibility(ctx, 2);
  const where: string[] = ['c.client_id = $1', vis.sql];
  const params: unknown[] = [ctx.clientId, ...vis.params];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.year && /^\d{4}$/.test(q.year)) {
    const y = push(Number(q.year));
    where.push(`daterange(c.period_from, c.period_to, '[]') && daterange(make_date(${y}::int,1,1), make_date(${y}::int,12,31), '[]')`);
  }
  if (q.type && isUuid(q.type)) where.push(`c.type_id = ${push(q.type)}`);
  if (q.network && isUuid(q.network)) where.push(`c.network_id = ${push(q.network)}`);
  if (q.owner && isUuid(q.owner)) where.push(`c.owner_id = ${push(q.owner)}`);
  if (q.group && isUuid(q.group)) where.push(`n.group_id = ${push(q.group)}`);
  if (q.q && q.q.trim()) {
    const term = q.q.trim().slice(0, 100);
    const like = push(`%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    const num = push(term.replace(/^К-?/i, ''));
    where.push(`(c.title ilike ${like} or n.name ilike ${like} or c.number::text = ${num})`);
  }
  if (q.overdue === '1') where.push(`c.control_date < current_date and c.stage = any(array['PREPARATION','NEGOTIATION','APPROVAL'])`);
  // Количество по этапам — по выборке без фильтра этапа, чтобы фильтр показывал, что в каждом этапе.
  const baseWhere = where.join(' and ');
  const stageParams = [...params];
  if (q.stage && (STAGES as readonly string[]).includes(q.stage)) where.push(`c.stage = ${push(q.stage)}`);
  else if (q.stage === 'ACTIVE') where.push(`c.stage <> all(array['CANCELLED','CLOSED'])`);
  const { rows } = await ctx.db.query(
    `select c.id, c.number, c.title, c.stage, c.stage_changed_at, c.period_from, c.period_to, c.control_date, c.updated_at,
            (c.control_date < current_date and c.stage = any(array['PREPARATION','NEGOTIATION','APPROVAL'])) overdue,
            n.id network_id, n.name network_name, n.regions network_regions,
            t.id type_id, t.name type_name,
            u.id owner_id, u.display_name owner_name,
            (select count(*)::int from kam.campaign_legal_entity e where e.client_id = c.client_id and e.campaign_id = c.id) legal_entities,
            v.number version, v.total_investment::float8 investment, v.total_turnover::float8 turnover
       from kam.campaign c
       left join lateral (select number, total_investment, total_turnover from kam.offer_version ov
                           where ov.client_id = c.client_id and ov.campaign_id = c.id order by number desc limit 1) v on true
       join kam.network n on n.client_id = c.client_id and n.id = c.network_id
       join kam.campaign_type t on t.client_id = c.client_id and t.id = c.type_id
       join kam.app_user u on u.id = c.owner_id
      where ${where.join(' and ')}
      order by (c.stage = any(array['CANCELLED','CLOSED'])), c.control_date, n.name
      limit 1000`, params);
  const { rows: stageRows } = await ctx.db.query<{ stage: Stage; n: number; overdue: number }>(
    `select c.stage, count(*)::int n,
            count(*) filter (where c.control_date < current_date and c.stage = any(array['PREPARATION','NEGOTIATION','APPROVAL']))::int overdue
       from kam.campaign c join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where ${baseWhere} group by c.stage`, stageParams);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  let overdue = 0;
  for (const r of stageRows) { byStage[r.stage] = r.n; overdue += r.overdue; }
  const active = STAGES.filter((s) => s !== 'CANCELLED' && s !== 'CLOSED').reduce((a, s) => a + byStage[s], 0);
  // Суммы — по текущим версиям показанных кампаний, без отменённых.
  const counted = rows.filter((r) => r.stage !== 'CANCELLED' && r.version);
  const investment = Math.round(counted.reduce((a, r) => a + r.investment, 0) * 100) / 100;
  const turnover = Math.round(counted.reduce((a, r) => a + r.turnover, 0) * 100) / 100;
  return {
    items: rows.map((r) => ({ ...r, roi: r.investment > 0 ? Math.round((r.turnover / r.investment) * 100) / 100 : null })),
    kpi: {
      active, overdue, investment, turnover, roi: investment > 0 ? Math.round((turnover / investment) * 100) / 100 : null, with_versions: counted.length,
      awaiting_decision: byStage.APPROVAL,
      approved: byStage.APPROVED + byStage.CONFIRMED + byStage.FINAL,
      by_stage: byStage,
    },
  };
}

// Карточка ------------------------------------------------------------------

async function loadVisible(ctx: Ctx, id: string, q: Pick<Tx, 'query'> = ctx.db) {
  if (!isUuid(id)) throw notFound();
  const vis = campaignVisibility(ctx, 3);
  const { rows } = await q.query(
    `select c.*, n.name network_name, n.regions network_regions, t.name type_name, t.period_split, t.control_days,
            u.display_name owner_name, u.email owner_email, cb.display_name created_by_name
       from kam.campaign c
       join kam.network n on n.client_id = c.client_id and n.id = c.network_id
       join kam.campaign_type t on t.client_id = c.client_id and t.id = c.type_id
       join kam.app_user u on u.id = c.owner_id
       join kam.app_user cb on cb.id = c.created_by
      where c.client_id = $1 and c.id = $2 and ${vis.sql}`, [ctx.clientId, id, ...vis.params]);
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, any> & { id: string; stage: Stage; owner_id: string; network_id: string; revision: number };
}

function actionsFor(ctx: Ctx, c: { stage: Stage; owner_id: string }) {
  const edit = canEditFor(ctx, c.owner_id);
  const a: string[] = [];
  if (edit && EDITABLE_STAGES.includes(c.stage)) a.push('EDIT');
  if (edit && c.stage === 'PREPARATION') a.push('START_NEGOTIATION');
  if (edit && CANCELLABLE.includes(c.stage)) a.push('CANCEL');
  if (edit && c.stage === 'FINAL') a.push('CLOSE');
  if (edit && (EDITABLE_STAGES.includes(c.stage) || c.stage === 'APPROVED')) a.push('NEW_VERSION');
  if (edit && c.stage === 'NEGOTIATION') a.push('SUBMIT');
  if (edit && c.stage === 'APPROVED') a.push('CONFIRM');
  if (edit && c.stage === 'CONFIRMED') a.push('FINALIZE');
  if (edit && c.stage !== 'CANCELLED' && c.stage !== 'CLOSED') a.push('UPLOAD');
  return a;
}

async function docRef(ctx: Ctx, id: string, at: string) {
  const d = (await ctx.db.query<{ id: string; file_name: string; kind: string; mime: string }>('select id, file_name, kind, mime from kam.document where client_id=$1 and id=$2', [ctx.clientId, id])).rows[0];
  return d ? { ...d, at } : null;
}

export async function getCampaign(ctx: Ctx, id: string) {
  const c = await loadVisible(ctx, id);
  const { rows: entities } = await ctx.db.query(
    `select le.id, le.inn, le.name, le.active, (ce.legal_entity_id is not null) selected
       from kam.legal_entity le
       left join kam.campaign_legal_entity ce on ce.client_id = le.client_id and ce.campaign_id = $3 and ce.legal_entity_id = le.id
      where le.client_id = $1 and le.network_id = $2 and (le.active or ce.legal_entity_id is not null)
      order by le.name`, [ctx.clientId, c.network_id, c.id]);
  const { rows: events } = await ctx.db.query(
    `select e.id, e.kind, e.from_stage, e.to_stage, e.comment, e.payload, e.at, u.display_name actor_name
       from kam.campaign_event e left join kam.app_user u on u.id = e.actor
      where e.client_id = $1 and e.campaign_id = $2 order by e.at desc, e.id`, [ctx.clientId, c.id]);
  const overdue = c.control_date < new Date().toISOString().slice(0, 10) && OPEN_STAGES.includes(c.stage);
  return {
    data: {
      id: c.id, number: c.number, title: c.title, stage: c.stage, stage_changed_at: c.stage_changed_at, cancel_reason: c.cancel_reason,
      period_from: c.period_from, period_to: c.period_to, control_date: c.control_date, overdue,
      network: { id: c.network_id, name: c.network_name, regions: c.network_regions },
      type: { id: c.type_id, name: c.type_name, period_split: c.period_split },
      owner: { id: c.owner_id, name: c.owner_name, email: c.owner_email },
      created_by: c.created_by_name, created_at: c.created_at, updated_at: c.updated_at, revision: c.revision,
      legal_entities: entities, events, actions: actionsFor(ctx, c),
      confirmation: c.confirmation_document_id ? await docRef(ctx, c.confirmation_document_id, c.confirmed_at) : null,
      final_terms: c.final_document_id ? await docRef(ctx, c.final_document_id, c.finalized_at) : null,
    },
    etag: campaignEtag(c.id, c.revision),
  };
}

// Проверки реквизитов -------------------------------------------------------

async function checkOwner(tx: Tx, ctx: Ctx, ownerId: string, networkId: string) {
  if (!isUuid(ownerId)) throw invalid('owner_id', 'Укажите ответственного.');
  if (!canEditFor(ctx, ownerId)) {
    throw ownerId === ctx.principal.userId ? forbidden('В вашей роли нельзя вести кампании.') : invalid('owner_id', 'Назначить можно только себя или подчинённого.', 'OWNER_NOT_ALLOWED');
  }
  if (!(await isAssigned(tx, ctx.clientId, ownerId, networkId))) {
    throw invalid('owner_id', 'Ответственный не закреплён за этой сетью. Закрепление настраивает администратор.', 'NETWORK_NOT_ASSIGNED');
  }
}

async function checkEntities(tx: Tx, ctx: Ctx, networkId: string, ids: unknown): Promise<string[]> {
  if (ids === undefined) {
    const { rows } = await tx.query<{ id: string }>('select id from kam.legal_entity where client_id=$1 and network_id=$2 and active order by name', [ctx.clientId, networkId]);
    if (!rows.length) throw invalid('legal_entity_ids', 'У сети нет действующих юрлиц. Добавьте ИНН в справочнике сетей.', 'NO_LEGAL_ENTITIES');
    return rows.map((r) => r.id);
  }
  if (!Array.isArray(ids) || !ids.every(isUuid)) throw invalid('legal_entity_ids', 'Некорректный список юрлиц.');
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw invalid('legal_entity_ids', 'Выберите хотя бы одно юрлицо сети.', 'NO_LEGAL_ENTITIES');
  const { rows } = await tx.query<{ id: string }>(
    'select id from kam.legal_entity where client_id=$1 and network_id=$2 and active and id = any($3::uuid[])', [ctx.clientId, networkId, uniq]);
  if (rows.length !== uniq.length) throw invalid('legal_entity_ids', 'Юрлицо не принадлежит сети или неактивно.');
  return uniq;
}

async function overlaps(tx: Tx, ctx: Ctx, c: { id: string | null; network_id: string; type_id: string; period_from: string; period_to: string }) {
  const { rows } = await tx.query<{ id: string; number: number; title: string }>(
    `select id, number, title from kam.campaign
      where client_id=$1 and network_id=$2 and type_id=$3 and ($4::uuid is null or id <> $4)
        and stage <> all(array['CANCELLED','CLOSED'])
        and daterange(period_from, period_to, '[]') && daterange($5::date, $6::date, '[]')
      order by number`, [ctx.clientId, c.network_id, c.type_id, c.id, c.period_from, c.period_to]);
  return rows.length ? [{ code: 'PERIOD_OVERLAP', message: 'У сети уже есть кампания этого типа на пересекающийся период.', campaigns: rows }] : [];
}

// Команды -------------------------------------------------------------------

export async function createCampaign(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  if (!ctx.access.permissions.has('CAMPAIGN_EDIT') && !ctx.access.permissions.has('CAMPAIGN_EDIT_SUBORDINATES')) throw forbidden('В вашей роли нельзя создавать кампании.');
  if (!isUuid(b.network_id)) throw required('network_id', 'Выберите аптечную сеть.');
  if (!isUuid(b.type_id)) throw required('type_id', 'Выберите тип кампании.');
  const net = (await tx.query<{ archived: boolean }>('select archived from kam.network where client_id=$1 and id=$2', [ctx.clientId, b.network_id])).rows[0];
  if (!net || net.archived) throw invalid('network_id', 'Сеть не найдена.');
  const type = (await tx.query<{ control_days: number; archived: boolean }>('select control_days, archived from kam.campaign_type where client_id=$1 and id=$2', [ctx.clientId, b.type_id])).rows[0];
  if (!type || type.archived) throw invalid('type_id', 'Тип кампании не найден.');
  const title = textField(b.title, 'title', 200);
  const from = dateField(b.period_from, 'period_from')!;
  const to = dateField(b.period_to, 'period_to')!;
  if (to < from) throw invalid('period_to', 'Окончание периода раньше начала.');
  const control = dateField(b.control_date, 'control_date', true) ?? addDays(from, -type.control_days);
  if (control > to) throw invalid('control_date', 'Контрольная дата позже окончания периода.');
  const ownerId = (b.owner_id ?? ctx.principal.userId) as string;
  await checkOwner(tx, ctx, ownerId, b.network_id);
  const entities = await checkEntities(tx, ctx, b.network_id, b.legal_entity_ids);
  const id = randomUUID();
  const warnings = await overlaps(tx, ctx, { id: null, network_id: b.network_id, type_id: b.type_id, period_from: from, period_to: to });
  const counter = await tx.query<{ last_no: number }>(
    `insert into kam.campaign_counter(client_id, last_no) values ($1, 1)
     on conflict (client_id) do update set last_no = kam.campaign_counter.last_no + 1 returning last_no`, [ctx.clientId]);
  const last_no = counter.rows[0]!.last_no;
  await tx.query(
    `insert into kam.campaign(client_id, id, number, network_id, type_id, title, period_from, period_to, control_date, owner_id, stage, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARATION',$11)`,
    [ctx.clientId, id, last_no, b.network_id, b.type_id, title, from, to, control, ownerId, ctx.principal.userId]);
  for (const e of entities) {
    await tx.query('insert into kam.campaign_legal_entity(client_id, campaign_id, legal_entity_id) values ($1,$2,$3)', [ctx.clientId, id, e]);
  }
  await campaignEvent(tx, ctx, id, 'CREATED', { to: 'PREPARATION' });
  await audit(tx, ctx, { entityType: 'campaign', entityId: id, action: 'CREATE', after: { title, network_id: b.network_id, type_id: b.type_id, period_from: from, period_to: to, control_date: control, owner_id: ownerId, legal_entity_ids: entities } });
  return { status: 201, body: { id, number: last_no, warnings }, etag: campaignEtag(id, 1) };
}

export async function updateCampaign(tx: Tx, ctx: Ctx, id: string, ifMatch: string | undefined, b: Record<string, unknown>): Promise<CommandResult> {
  const locked = await lockCampaign(tx, ctx, id, ifMatch);
  const before = await loadVisible(ctx, id, tx);
  if (!canEditFor(ctx, before.owner_id)) throw forbidden();
  if (!EDITABLE_STAGES.includes(before.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Реквизиты меняются только на этапах подготовки и переговоров.');
  const next = {
    title: b.title === undefined ? before.title : textField(b.title, 'title', 200),
    period_from: b.period_from === undefined ? before.period_from : dateField(b.period_from, 'period_from')!,
    period_to: b.period_to === undefined ? before.period_to : dateField(b.period_to, 'period_to')!,
    control_date: b.control_date === undefined ? before.control_date : dateField(b.control_date, 'control_date')!,
    owner_id: (b.owner_id === undefined ? before.owner_id : b.owner_id) as string,
  };
  if (next.period_to < next.period_from) throw invalid('period_to', 'Окончание периода раньше начала.');
  if (next.control_date > next.period_to) throw invalid('control_date', 'Контрольная дата позже окончания периода.');
  if (next.owner_id !== before.owner_id) await checkOwner(tx, ctx, next.owner_id, locked.network_id);
  await tx.query(
    'update kam.campaign set title=$3, period_from=$4, period_to=$5, control_date=$6, owner_id=$7 where client_id=$1 and id=$2',
    [ctx.clientId, id, next.title, next.period_from, next.period_to, next.control_date, next.owner_id]);
  let entities: string[] | undefined;
  if (b.legal_entity_ids !== undefined) {
    entities = await checkEntities(tx, ctx, locked.network_id, b.legal_entity_ids);
    await tx.query('delete from kam.campaign_legal_entity where client_id=$1 and campaign_id=$2', [ctx.clientId, id]);
    for (const e of entities) await tx.query('insert into kam.campaign_legal_entity(client_id, campaign_id, legal_entity_id) values ($1,$2,$3)', [ctx.clientId, id, e]);
  }
  const rev = await bumpCampaign(tx, ctx, id);
  const changes: string[] = [];
  if (next.title !== before.title) changes.push('название');
  if (next.period_from !== before.period_from || next.period_to !== before.period_to) changes.push('период');
  if (next.control_date !== before.control_date) changes.push('контрольная дата');
  if (next.owner_id !== before.owner_id) changes.push('ответственный');
  if (entities) changes.push('юрлица');
  if (changes.length) await campaignEvent(tx, ctx, id, 'UPDATED', { payload: { changes } });
  await audit(tx, ctx, { entityType: 'campaign', entityId: id, action: 'UPDATE',
    before: { title: before.title, period_from: before.period_from, period_to: before.period_to, control_date: before.control_date, owner_id: before.owner_id },
    after: { ...next, ...(entities ? { legal_entity_ids: entities } : {}) } });
  const warnings = await overlaps(tx, ctx, { id, network_id: locked.network_id, type_id: before.type_id, period_from: next.period_from, period_to: next.period_to });
  return { status: 200, body: { id, revision: rev, warnings }, etag: campaignEtag(id, rev) };
}

const STAGE_DOCS: Record<string, { kinds: string[]; code: string; message: string }> = {
  CONFIRM: { kinds: ['NETWORK_CONFIRMATION', 'SIGNED_CONTRACT'], code: 'CONFIRMATION_DOCUMENT_REQUIRED', message: 'Приложите подтверждение сети: документ типа «Подтверждение сети» или «Подписанный договор».' },
  FINALIZE: { kinds: ['FINAL_TERMS', 'SIGNED_CONTRACT'], code: 'FINAL_DOCUMENT_REQUIRED', message: 'Приложите финальный файл условий: документ типа «Финальные условия» или «Подписанный договор».' },
};

export async function transition(tx: Tx, ctx: Ctx, id: string, ifMatch: string | undefined, b: { action?: unknown; comment?: unknown; document_id?: unknown }): Promise<CommandResult> {
  const locked = await lockCampaign(tx, ctx, id, ifMatch);
  await loadVisible(ctx, id, tx);
  const action = b.action;
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 2000) throw invalid('comment', 'Не длиннее 2000 символов.');
  const allowed = actionsFor(ctx, { stage: locked.stage as Stage, owner_id: locked.owner_id });
  if (typeof action !== 'string' || !['START_NEGOTIATION', 'CANCEL', 'CLOSE', 'CONFIRM', 'FINALIZE'].includes(action)) throw invalid('action', 'Неизвестное действие.');
  if (!allowed.includes(action)) {
    if (!canEditFor(ctx, locked.owner_id)) throw forbidden();
    throw new ApiError(409, 'TRANSITION_NOT_ALLOWED', 'Это действие недоступно на текущем этапе.', { stage: locked.stage });
  }
  let to: Stage;
  let doc: { id: string; file_name: string } | undefined;
  if (action === 'CONFIRM' || action === 'FINALIZE') {
    const rule = STAGE_DOCS[action]!;
    if (!isUuid(b.document_id)) throw new ApiError(422, rule.code, rule.message, {}, 'document_id');
    doc = (await tx.query<{ id: string; file_name: string }>(
      'select id, file_name from kam.document where client_id=$1 and campaign_id=$2 and id=$3 and archived_at is null and kind = any($4::text[])',
      [ctx.clientId, id, b.document_id, rule.kinds])).rows[0];
    if (!doc) throw new ApiError(422, rule.code, rule.message, {}, 'document_id');
  }
  if (action === 'START_NEGOTIATION') to = 'NEGOTIATION';
  else if (action === 'CONFIRM') to = 'CONFIRMED';
  else if (action === 'FINALIZE') to = 'FINAL';
  else if (action === 'CLOSE') to = 'CLOSED';
  else {
    if (!comment) throw required('comment', 'Укажите причину отмены.');
    to = 'CANCELLED';
  }
  if (to === 'CANCELLED') await closeApproval(tx, ctx.clientId, id, 'CANCELLED');
  await tx.query(
    'update kam.campaign set stage=$3, stage_changed_at=now(), cancel_reason=$4 where client_id=$1 and id=$2',
    [ctx.clientId, id, to, to === 'CANCELLED' ? comment : null]);
  if (action === 'CONFIRM') await tx.query('update kam.campaign set confirmation_document_id=$3, confirmed_at=now() where client_id=$1 and id=$2', [ctx.clientId, id, doc!.id]);
  if (action === 'FINALIZE') await tx.query('update kam.campaign set final_document_id=$3, finalized_at=now() where client_id=$1 and id=$2', [ctx.clientId, id, doc!.id]);
  const rev = await bumpCampaign(tx, ctx, id);
  await campaignEvent(tx, ctx, id, 'STAGE', { from: locked.stage, to, comment: comment || null, payload: doc ? { document_id: doc.id, file_name: doc.file_name } : undefined });
  if (action === 'CONFIRM') {
    // Сеть подтвердила условия: узнают согласовавшие и руководитель ответственного.
    const { rows } = await tx.query<{ u: string; title: string; network: string }>(
      `select distinct s.decided_by u, c.title, n.name network from kam.approval a join kam.approval_step s on s.client_id = a.client_id and s.approval_id = a.id and s.status = 'APPROVED'
         join kam.campaign c on c.client_id = a.client_id and c.id = a.campaign_id join kam.network n on n.client_id = c.client_id and n.id = c.network_id
        where a.client_id=$1 and a.campaign_id=$2 and a.status='APPROVED'`, [ctx.clientId, id]);
    const mgr = (await tx.query<{ m: string }>('select manager_id m from kam.user_manager where client_id=$1 and user_id=$2 and valid @> current_date', [ctx.clientId, locked.owner_id])).rows[0]?.m;
    const names = (await tx.query<{ title: string; network: string }>('select c.title, n.name network from kam.campaign c join kam.network n on n.client_id=c.client_id and n.id=c.network_id where c.client_id=$1 and c.id=$2', [ctx.clientId, id])).rows[0]!;
    await notify(tx, ctx.clientId, { kind: 'CONFIRMED', users: [...rows.map((r) => r.u), mgr], campaignId: id, actorId: ctx.principal.userId,
      title: `Сеть подтвердила условия: ${names.network} — ${names.title}`, body: `Подтверждение: ${doc!.file_name}` });
  }
  await audit(tx, ctx, { entityType: 'campaign', entityId: id, action, before: { stage: locked.stage }, after: { stage: to }, reason: comment || null });
  return { status: 200, body: { id, stage: to, revision: rev }, etag: campaignEtag(id, rev) };
}
