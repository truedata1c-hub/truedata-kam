// Работа с сетью (ТЗ §7): контакты сети, активности кампании, переписка с упоминаниями.

import { randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { ApiError, forbidden, invalid, notFound, required } from './errors.js';
import { type Ctx, campaignVisibility, canEditFor, visibleNetworkIds } from './access.js';
import { type CommandResult, audit, campaignEvent, isUuid, lockCampaignRecord } from './commands.js';
import { canSee, directory, routeCampaign } from './routes.js';
import { notify } from './notify.js';

type Q = Pick<Tx, 'query'>;

const str = (v: unknown, field: string, max: number, need = false) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (need && !s) throw required(field);
  if (s.length > max) throw invalid(field, `Не длиннее ${max} символов.`);
  return s;
};

async function campaignOf(q: Q, ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const vis = campaignVisibility(ctx, 3);
  const c = (await q.query<{ id: string; owner_id: string | null; network_id: string; stage: string; title: string; network: string }>(
    `select c.id, c.owner_id, c.network_id, c.stage, c.title, n.name network from kam.campaign_with_owner c join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where c.client_id=$1 and c.id=$2 and ${vis.sql}`, [ctx.clientId, id, ...vis.params])).rows[0];
  if (!c) throw notFound();
  return c;
}

// Контакты сети ---------------------------------------------------------------------

async function networkAccess(q: Q, ctx: Ctx, networkId: string): Promise<{ edit: boolean }> {
  if (!isUuid(networkId)) throw notFound();
  const network = (await q.query<{ owner_id: string | null }>(
    `select a.user_id as owner_id from kam.network n left join kam.kam_assignment a
       on a.client_id=n.client_id and a.network_id=n.id and a.valid @> current_date
      where n.client_id=$1 and n.id=$2`, [ctx.clientId, networkId])).rows[0];
  if (!network) throw notFound();
  const edit = ctx.access.permissions.has('ADMIN') || canEditFor(ctx, network.owner_id);
  if (edit) return { edit };
  const nets = await visibleNetworkIds(ctx, q);
  if (nets === null || nets.includes(networkId)) return { edit: false };
  // Согласующий видит контакты сети кампании, которую он согласует.
  const vis = campaignVisibility(ctx, 3);
  const seen = (await q.query(`select 1 from kam.campaign_with_owner c where c.client_id=$1 and c.network_id=$2 and ${vis.sql} limit 1`, [ctx.clientId, networkId, ...vis.params])).rowCount;
  if (!seen) throw notFound();
  return { edit: false };
}

export async function listContacts(ctx: Ctx, networkId: string) {
  const a = await networkAccess(ctx.db, ctx, networkId);
  const { rows } = await ctx.db.query(
    `select id, name, position, phone, email, note, is_key, archived_at from kam.network_contact where client_id=$1 and network_id=$2
      order by archived_at nulls first, is_key desc, name`, [ctx.clientId, networkId]);
  return { items: rows, can_edit: a.edit };
}

function contactBody(b: Record<string, unknown>) {
  const email = str(b.email, 'email', 320);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('email', 'Некорректный адрес почты.');
  return { name: str(b.name, 'name', 120, true), position: str(b.position, 'position', 120), phone: str(b.phone, 'phone', 40), email, note: str(b.note, 'note', 500), is_key: Boolean(b.is_key) };
}

export async function saveContact(tx: Tx, ctx: Ctx, networkId: string | null, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  let net = networkId;
  let before: Record<string, unknown> | undefined;
  if (id) {
    if (!isUuid(id)) throw notFound();
    net = (await tx.query<{ network_id: string }>('select network_id from kam.network_contact where client_id=$1 and id=$2', [ctx.clientId, id])).rows[0]?.network_id ?? null;
  }
  if (!isUuid(net)) throw notFound();
  await tx.query('select id from kam.network where client_id=$1 and id=$2 for share', [ctx.clientId, net]);
  const a = await networkAccess(tx, ctx, net);
  if (!a.edit) throw forbidden('Контакты сети ведут закреплённые КАМ и их руководители.');
  if (id) {
    before = (await tx.query('select network_id, name, position, phone, email, note, is_key, archived_at from kam.network_contact where client_id=$1 and id=$2 for update', [ctx.clientId, id])).rows[0];
    if (!before) throw notFound();
  }
  if (b.archived === true) {
    if (!before) throw notFound();
    await tx.query('update kam.network_contact set archived_at=now(), updated_at=now() where client_id=$1 and id=$2', [ctx.clientId, id]);
    await audit(tx, ctx, { entityType: 'contact', entityId: id, action: 'ARCHIVE', before });
    return { status: 200, body: { id } };
  }
  const c = contactBody(b);
  const newId = id ?? randomUUID();
  if (id) {
    await tx.query('update kam.network_contact set name=$3, position=$4, phone=$5, email=$6, note=$7, is_key=$8, archived_at=null, updated_at=now() where client_id=$1 and id=$2',
      [ctx.clientId, id, c.name, c.position, c.phone, c.email, c.note, c.is_key]);
  } else {
    await tx.query('insert into kam.network_contact(client_id, id, network_id, name, position, phone, email, note, is_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [ctx.clientId, newId, net, c.name, c.position, c.phone, c.email, c.note, c.is_key, ctx.principal.userId]);
  }
  await audit(tx, ctx, { entityType: 'contact', entityId: newId, action: id ? 'UPDATE' : 'CREATE', before, after: c });
  return { status: id ? 200 : 201, body: { id: newId } };
}

// Активности кампании ------------------------------------------------------------------

export const ACTIVITY_KINDS = ['MEETING', 'CALL', 'EMAIL'] as const;
const KIND_LABEL: Record<string, string> = { MEETING: 'Встреча', CALL: 'Звонок', EMAIL: 'Письмо' };

export async function listActivities(ctx: Ctx, campaignId: string) {
  const c = await campaignOf(ctx.db, ctx, campaignId);
  const { rows } = await ctx.db.query(
    `select a.id, a.kind, a.at, a.status, a.purpose, a.outcome, a.contact_id, nc.name contact_name, nc.position contact_position,
            cb.display_name created_by_name, db.display_name done_by_name, a.done_at
       from kam.activity a left join kam.network_contact nc on nc.client_id = a.client_id and nc.id = a.contact_id
       join kam.employee_profile cb on cb.client_id = a.client_id and cb.id = a.created_by left join kam.employee_profile db on db.client_id = a.client_id and db.id = a.done_by
      where a.client_id=$1 and a.campaign_id=$2 order by (a.status = 'PLANNED') desc, a.at desc`, [ctx.clientId, campaignId]);
  return { items: rows, can_edit: canEditFor(ctx, c.owner_id) && !['CANCELLED', 'CLOSED'].includes(c.stage) };
}

export async function saveActivity(tx: Tx, ctx: Ctx, campaignId: string, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  await lockCampaignRecord(tx, ctx.clientId, campaignId);
  const c = await campaignOf(tx, ctx, campaignId);
  if (!canEditFor(ctx, c.owner_id)) throw forbidden();
  if (['CANCELLED', 'CLOSED'].includes(c.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Кампания отменена или закрыта.');
  let before: { status: string } | undefined;
  if (id) {
    if (!isUuid(id)) throw notFound();
    before = (await tx.query<{ status: string }>('select status from kam.activity where client_id=$1 and campaign_id=$2 and id=$3 for update', [ctx.clientId, campaignId, id])).rows[0];
    if (!before) throw notFound();
  }
  const kind = b.kind;
  if (typeof kind !== 'string' || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) throw invalid('kind', 'Выберите формат: встреча, звонок или письмо.');
  const at = typeof b.at === 'string' ? new Date(b.at) : null;
  if (!at || Number.isNaN(at.getTime())) throw invalid('at', 'Укажите дату и время.');
  const status = b.status ?? 'PLANNED';
  if (status !== 'PLANNED' && status !== 'DONE' && status !== 'CANCELLED') throw invalid('status', 'Неизвестный статус.');
  const purpose = str(b.purpose, 'purpose', 1000);
  const outcome = str(b.outcome, 'outcome', 2000);
  if (status === 'DONE' && !outcome) throw required('outcome', 'Опишите итог завершённой активности.');
  if (status === 'PLANNED' && !purpose) throw required('purpose', 'Укажите цель активности.');
  let contact: string | null = null;
  if (b.contact_id) {
    if (!isUuid(b.contact_id)) throw invalid('contact_id', 'Некорректный контакт.');
    const ok = (await tx.query('select 1 from kam.network_contact where client_id=$1 and id=$2 and network_id=$3', [ctx.clientId, b.contact_id, c.network_id])).rowCount;
    if (!ok) throw invalid('contact_id', 'Контакт не относится к сети кампании.');
    contact = b.contact_id;
  }
  const newId = id ?? randomUUID();
  const becameDone = status === 'DONE' && before?.status !== 'DONE';
  if (id) {
    await tx.query(
      `update kam.activity set kind=$4, at=$5, contact_id=$6, status=$7, purpose=$8, outcome=$9,
              done_by = case when $10 then $11::uuid else done_by end, done_at = case when $10 then now() else done_at end
        where client_id=$1 and campaign_id=$2 and id=$3`,
      [ctx.clientId, campaignId, id, kind, at, contact, status, purpose, outcome, becameDone, ctx.principal.userId]);
  } else {
    await tx.query(
      `insert into kam.activity(client_id, id, campaign_id, kind, at, contact_id, status, purpose, outcome, created_by, done_by, done_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $11 then $10::uuid end, case when $11 then now() end)`,
      [ctx.clientId, newId, campaignId, kind, at, contact, status, purpose, outcome, ctx.principal.userId, becameDone]);
  }
  // Завершённая активность попадает в историю кампании — «пульс переговоров».
  if (becameDone) await campaignEvent(tx, ctx, campaignId, 'ACTIVITY_DONE', { comment: outcome, payload: { kind, kind_label: KIND_LABEL[kind], at: at.toISOString() } });
  await audit(tx, ctx, { entityType: 'activity', entityId: newId, action: id ? 'UPDATE' : 'CREATE', after: { campaign_id: campaignId, kind, at, status, contact_id: contact } });
  return { status: id ? 200 : 201, body: { id: newId } };
}

// Переписка -------------------------------------------------------------------------------

/** Кто может участвовать в переписке: все, кто видит кампанию, включая согласующих и их заместителей. */
export async function participants(q: Q, ctx: Ctx, campaignId: string) {
  await campaignOf(q, ctx, campaignId);
  const camp = await routeCampaign(q, ctx.clientId, campaignId);
  const d = await directory(q, ctx.clientId);
  const { rows } = await q.query<{ ids: string[] }>(
    `select coalesce(array_agg(distinct x), '{}') ids from (
       select unnest(candidates) x from kam.approval_step where client_id=$1 and campaign_id=$2
       union select decided_by from kam.approval_step where client_id=$1 and campaign_id=$2 and decided_by is not null
       union select sb.deputy_id from kam.substitution sb join kam.approval_step s on s.client_id = sb.client_id and sb.user_id = any(s.candidates)
              where s.client_id=$1 and s.campaign_id=$2 and s.status='ACTIVE' and sb.valid @> current_date) t`, [ctx.clientId, campaignId]);
  const extra = new Set(rows[0]!.ids);
  return [...d.users.values()].filter((u) => extra.has(u.id) || canSee(u, camp, d))
    .map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export async function listComments(ctx: Ctx, campaignId: string) {
  await campaignOf(ctx.db, ctx, campaignId);
  const { rows } = await ctx.db.query(
    `select cc.id, cc.body, cc.created_at, cc.author_id, u.display_name author_name, cc.mentions,
            coalesce((select json_agg(json_build_object('id', m.id, 'name', m.display_name)) from kam.employee_profile m where m.client_id = cc.client_id and m.id = any(cc.mentions)), '[]') mentioned
       from kam.campaign_comment cc join kam.employee_profile u on u.client_id = cc.client_id and u.id = cc.author_id
      where cc.client_id=$1 and cc.campaign_id=$2 order by cc.created_at`, [ctx.clientId, campaignId]);
  return { items: rows.map(({ mentions: _m, ...r }) => ({ ...r, mine: r.author_id === ctx.principal.userId })), participants: await participants(ctx.db, ctx, campaignId) };
}

export async function addComment(tx: Tx, ctx: Ctx, campaignId: string, b: Record<string, unknown>): Promise<CommandResult> {
  await lockCampaignRecord(tx, ctx.clientId, campaignId);
  const c = await campaignOf(tx, ctx, campaignId);
  const body = str(b.body, 'body', 4000, true);
  const ids = Array.isArray(b.mention_ids) ? [...new Set(b.mention_ids)] : [];
  if (!ids.every(isUuid)) throw invalid('mention_ids', 'Некорректные упоминания.');
  let mentions: string[] = [];
  if (ids.length) {
    const allowed = new Set((await participants(tx, ctx, campaignId)).map((p) => p.id));
    if (!ids.every((x) => allowed.has(x as string))) throw invalid('mention_ids', 'Упомянуть можно только участника, который видит кампанию.');
    mentions = ids as string[];
  }
  const id = randomUUID();
  await tx.query('insert into kam.campaign_comment(client_id, id, campaign_id, author_id, body, mentions) values ($1,$2,$3,$4,$5,$6)',
    [ctx.clientId, id, campaignId, ctx.principal.userId, body, mentions]);
  if (mentions.length) {
    await notify(tx, ctx.clientId, { kind: 'MENTION', users: mentions, campaignId, actorId: ctx.principal.userId,
      title: `Вас упомянули в переписке: ${c.network} — ${c.title}`, body: `${ctx.principal.displayName}: ${body.slice(0, 480)}` });
  }
  return { status: 201, body: { id } };
}
