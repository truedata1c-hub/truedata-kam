// Справочные данные для фильтров и форм в области видимости пользователя.

import { type Ctx, seesAll, visibleNetworkIds } from './access.js';
import { notFound } from './errors.js';
import { APP_TZ } from './time.js';
import { isUuid } from './commands.js';

export async function reference(ctx: Ctx) {
  const visible = await visibleNetworkIds(ctx);
  const { rows: networks } = await ctx.db.query(
    `select n.id, n.name, n.regions, n.group_id,
            (select count(*)::int from kam.legal_entity le where le.client_id = n.client_id and le.network_id = n.id and le.active) legal_entities
       from kam.network n where n.client_id = $1 and not n.archived and ($2::uuid[] is null or n.id = any($2::uuid[]))
      order by n.name`, [ctx.clientId, visible]);
  const { rows: groups } = await ctx.db.query('select id, name from kam.network_group where client_id=$1 order by name', [ctx.clientId]);
  const { rows: types } = await ctx.db.query(
    'select id, name, period_split, control_days from kam.campaign_type where client_id=$1 and not archived order by sort_order, name', [ctx.clientId]);
  const { rows: brands } = await ctx.db.query('select id, name from kam.brand where client_id=$1 and not archived order by name', [ctx.clientId]);
  // Ответственные для фильтра портфеля: сотрудники, ведущие кампании, в области видимости.
  const users = seesAll(ctx.access) ? null : (ctx.access.scopes.has('SUBORDINATES') ? ctx.access.team : [ctx.principal.userId]);
  const { rows: owners } = await ctx.db.query(
    `select distinct u.id, u.display_name name from kam.membership m join kam.app_user u on u.id = m.user_id
       join kam.user_business_role ur on ur.client_id = m.client_id and ur.user_id = m.user_id
       join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id and not r.archived and 'CAMPAIGN_EDIT' = any(r.permissions)
      where m.client_id = $1 and m.active and ($2::uuid[] is null or u.id = any($2::uuid[])) order by name`, [ctx.clientId, users]);
  // Сети, в которых пользователь может создавать кампании, и их текущие ответственные.
  const p = ctx.access.permissions;
  const candidates = [...new Set([...(p.has('CAMPAIGN_EDIT') ? [ctx.principal.userId] : []), ...(p.has('CAMPAIGN_EDIT_SUBORDINATES') ? ctx.access.team : [])])];
  const { rows: assignable } = candidates.length ? await ctx.db.query(
    `select u.id, u.display_name name, array_agg(ka.network_id order by ka.network_id) network_ids
       from kam.kam_assignment ka join kam.app_user u on u.id = ka.user_id
       join kam.membership m on m.client_id = ka.client_id and m.user_id = ka.user_id and m.active
      where ka.client_id = $1 and ka.user_id = any($2::uuid[]) and ka.valid @> current_date
        and exists (select 1 from kam.user_business_role ur join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id
                     where ur.client_id = ka.client_id and ur.user_id = ka.user_id and not r.archived and 'CAMPAIGN_EDIT' = any(r.permissions))
      group by u.id, u.display_name order by (u.id = $3) desc, u.display_name`, [ctx.clientId, candidates, ctx.principal.userId]) : { rows: [] };
  return { networks, groups, types, brands, owners, assignable, time_zone: APP_TZ };
}

/** Юрлица сети для формы кампании — только для сетей в области видимости. */
export async function networkEntities(ctx: Ctx, networkId: string) {
  if (!isUuid(networkId)) throw notFound();
  const visible = await visibleNetworkIds(ctx);
  if (visible && !visible.includes(networkId)) throw notFound();
  const { rows } = await ctx.db.query(
    'select id, inn, name from kam.legal_entity where client_id=$1 and network_id=$2 and active order by name', [ctx.clientId, networkId]);
  if (!rows.length) {
    const exists = (await ctx.db.query('select 1 from kam.network where client_id=$1 and id=$2', [ctx.clientId, networkId])).rowCount;
    if (!exists) throw notFound();
  }
  return { items: rows };
}
