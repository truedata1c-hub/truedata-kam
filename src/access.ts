// Права и видимость (ТЗ §3). Бизнес-роль клиента = набор полномочий + область видимости.
// Права читаются при каждом запросе: изменение ролей действует сразу.

import type { Db } from './db.js';
import type { Principal } from './auth.js';
import { forbidden, notFound } from './errors.js';

export const PERMISSIONS = ['CAMPAIGN_EDIT', 'CAMPAIGN_EDIT_SUBORDINATES', 'APPROVE', 'ANALYTICS', 'ADMIN'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const SCOPES = ['OWN', 'SUBORDINATES', 'ALL', 'BRANDS'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Access {
  permissions: Set<Permission>;
  scopes: Set<Scope>;
  roleNames: string[];
  /** Пользователь и все подчинённые на сегодня (для области «подчинённые» и ведения кампаний подчинённых). */
  team: string[];
}

export interface Ctx {
  db: Db;
  principal: Principal;
  clientId: string;
  requestId: string;
  access: Access;
}

type Q = Pick<Db, 'query'>;

export async function subordinates(q: Q, clientId: string, userId: string): Promise<string[]> {
  const { rows } = await q.query<{ user_id: string }>(
    `with recursive sub(user_id, depth) as (
       select $2::uuid, 0
       union
       select m.user_id, sub.depth + 1 from kam.user_manager m join sub on m.manager_id = sub.user_id
        where m.client_id = $1 and m.valid @> current_date and sub.depth < 20
     ) select distinct user_id from sub`, [clientId, userId]);
  return rows.map((r) => r.user_id);
}

/** Нет членства в клиенте — 404 (клиент «не существует» для пользователя). */
export async function loadAccess(q: Q, principal: Principal, clientId: string): Promise<Access> {
  if (!principal.clientIds.has(clientId)) throw notFound();
  const { rows } = await q.query<{ name: string; permissions: Permission[]; scope: Scope }>(
    `select r.name, r.permissions, r.scope from kam.user_business_role ur
       join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id and not r.archived
      where ur.client_id = $1 and ur.user_id = $2 order by r.name`, [clientId, principal.userId]);
  const permissions = new Set<Permission>(rows.flatMap((r) => r.permissions));
  const scopes = new Set<Scope>(rows.map((r) => r.scope));
  const team = scopes.has('SUBORDINATES') || permissions.has('CAMPAIGN_EDIT_SUBORDINATES')
    ? await subordinates(q, clientId, principal.userId)
    : [principal.userId];
  return { permissions, scopes, roleNames: rows.map((r) => r.name), team };
}

export function requirePermission(ctx: Ctx, ...any: Permission[]): void {
  if (!any.some((p) => ctx.access.permissions.has(p))) throw forbidden();
}

export const seesAll = (a: Access) => a.scopes.has('ALL') || a.scopes.has('BRANDS');

/**
 * Условие видимости кампании для SQL. Возвращает фрагмент с плейсхолдерами, начиная с номера `start`,
 * и значения. Ожидает псевдоним `c` для kam.campaign_with_owner.
 */
export function campaignVisibility(ctx: Ctx, start: number): { sql: string; params: unknown[] } {
  const a = ctx.access;
  if (seesAll(a)) return { sql: 'true', params: [] };
  const users = a.scopes.has('SUBORDINATES') ? a.team : [ctx.principal.userId];
  // Согласующий видит кампанию, по которой он исполнитель шага (или замещает исполнителя), даже вне своей области.
  return {
    sql: `(c.owner_id = any($${start}::uuid[])
          or exists (select 1 from kam.approval_step st where st.client_id = c.client_id and st.campaign_id = c.id
               and (st.candidates @> array[$${start + 1}::uuid] or st.decided_by = $${start + 1}
                    or exists (select 1 from kam.substitution sb where sb.client_id = st.client_id and sb.deputy_id = $${start + 1}
                                 and sb.valid @> current_date and sb.user_id = any(st.candidates)))))`,
    params: [users, ctx.principal.userId],
  };
}

/** Сети, с которыми пользователь может работать: закреплённые за ним (и подчинёнными) либо все. */
export async function visibleNetworkIds(ctx: Ctx, q: Q = ctx.db): Promise<string[] | null> {
  if (seesAll(ctx.access)) return null;
  const users = ctx.access.scopes.has('SUBORDINATES') ? ctx.access.team : [ctx.principal.userId];
  const { rows } = await q.query<{ network_id: string }>(
    'select distinct network_id from kam.kam_assignment where client_id=$1 and user_id = any($2::uuid[]) and valid @> current_date',
    [ctx.clientId, users]);
  return rows.map((r) => r.network_id);
}

/** Может ли пользователь вести кампанию с этим ответственным. */
export function canEditFor(ctx: Ctx, ownerId: string | null): boolean {
  if (!ownerId) return false;
  const p = ctx.access.permissions;
  if (ownerId === ctx.principal.userId && p.has('CAMPAIGN_EDIT')) return true;
  return p.has('CAMPAIGN_EDIT_SUBORDINATES') && ctx.access.team.includes(ownerId);
}
