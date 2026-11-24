// Администрирование клиента (ТЗ §3, §8): конструктор ролей, пользователи и оргструктура, сети и юрлица,
// бренды, типы кампаний, журнал. Все команды — с журналом в той же транзакции.

import { randomUUID } from 'node:crypto';
import { todayIso as today } from './time.js';
import type { Tx } from './db.js';
import { ApiError, invalid, notFound, required } from './errors.js';
import { type Ctx, PERMISSIONS, SCOPES, type Permission, type Scope, requirePermission } from './access.js';
import { ensureRoleNotInRoutes } from './routes.js';
import { type CommandResult, audit, isUuid } from './commands.js';
import { hashPassword, temporaryPassword } from './auth.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, field: string, max: number, opt = false): string => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s && !opt) throw required(field);
  if (s.length > max) throw invalid(field, `Не длиннее ${max} символов.`);
  return s;
};
const date = (v: unknown, field: string, opt = false): string | null => {
  if ((v === undefined || v === null || v === '') && opt) return null;
  if (typeof v !== 'string' || !DATE.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) {
    throw invalid(field, 'Укажите существующую дату в формате ГГГГ-ММ-ДД.');
  }
  return v;
};

/** Контрольное число ИНН (10 или 12 цифр) по правилам ФНС. */
export function innValid(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = [...inn].map(Number);
  const sum = (w: number[], n: number) => (w.reduce((a, k, i) => a + k * d[i]!, 0) % 11) % 10 === d[n];
  if (inn.length === 10) return sum([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
}

// Роли ---------------------------------------------------------------------

export async function listRoles(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const { rows } = await ctx.db.query(
    `select r.id, r.name, r.description, r.permissions, r.scope, r.archived,
            (select count(*)::int from kam.user_business_role ur join kam.membership m on m.client_id = ur.client_id and m.user_id = ur.user_id and m.active
              where ur.client_id = r.client_id and ur.role_id = r.id) users
       from kam.business_role r where r.client_id = $1 order by r.archived, r.name`, [ctx.clientId]);
  return { items: rows };
}

function roleBody(b: Record<string, unknown>) {
  const name = text(b.name, 'name', 120);
  const description = text(b.description, 'description', 500, true);
  if (!Array.isArray(b.permissions) || !b.permissions.every((p) => (PERMISSIONS as readonly string[]).includes(p as string))) {
    throw invalid('permissions', 'Неизвестное полномочие.');
  }
  const permissions = [...new Set(b.permissions as Permission[])].sort((a, c) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(c));
  if (!(SCOPES as readonly string[]).includes(b.scope as string)) throw invalid('scope', 'Выберите область видимости.');
  return { name, description, permissions, scope: b.scope as Scope };
}

export async function createRole(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const r = roleBody(b);
  const id = randomUUID();
  await tx.query('insert into kam.business_role(client_id, id, name, description, permissions, scope) values ($1,$2,$3,$4,$5,$6)',
    [ctx.clientId, id, r.name, r.description, r.permissions, r.scope]);
  await audit(tx, ctx, { entityType: 'role', entityId: id, action: 'CREATE', after: r });
  return { status: 201, body: { id } };
}

export async function updateRole(tx: Tx, ctx: Ctx, id: string, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(id)) throw notFound();
  const before = (await tx.query('select name, description, permissions, scope, archived from kam.business_role where client_id=$1 and id=$2 for update', [ctx.clientId, id])).rows[0];
  if (!before) throw notFound();
  const r = roleBody(b);
  const archived = b.archived === undefined ? before.archived : Boolean(b.archived);
  // Нельзя лишить клиента последнего администратора: иначе настройки станут недоступны.
  if (before.permissions.includes('ADMIN') && (!r.permissions.includes('ADMIN') || archived)) await ensureOtherAdmin(tx, ctx, { roleId: id });
  if (before.permissions.includes('APPROVE') && (!r.permissions.includes('APPROVE') || archived)) await ensureRoleNotInRoutes(tx, ctx.clientId, id);
  await tx.query('update kam.business_role set name=$3, description=$4, permissions=$5, scope=$6, archived=$7 where client_id=$1 and id=$2',
    [ctx.clientId, id, r.name, r.description, r.permissions, r.scope, archived]);
  await audit(tx, ctx, { entityType: 'role', entityId: id, action: 'UPDATE', before, after: { ...r, archived } });
  return { status: 200, body: { id } };
}

/** Остаётся ли у клиента активный администратор, если исключить роль или пользователя. */
async function ensureOtherAdmin(tx: Tx, ctx: Ctx, o: { roleId?: string; userId?: string }) {
  const { rows } = await tx.query<{ n: number }>(
    `select count(distinct ur.user_id)::int n from kam.user_business_role ur
       join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id and not r.archived and 'ADMIN' = any(r.permissions)
       join kam.membership m on m.client_id = ur.client_id and m.user_id = ur.user_id and m.active
       join kam.app_user u on u.id = ur.user_id and not u.disabled
      where ur.client_id = $1 and ($2::uuid is null or r.id <> $2) and ($3::uuid is null or ur.user_id <> $3)`,
    [ctx.clientId, o.roleId ?? null, o.userId ?? null]);
  if (!rows[0]!.n) throw new ApiError(422, 'LAST_ADMIN', 'У клиента должен остаться хотя бы один администратор.');
}

// Пользователи и оргструктура ----------------------------------------------

export async function listUsers(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const { rows } = await ctx.db.query(
    `select u.id, u.email, u.display_name, u.disabled, u.last_login_at, u.must_change_password, m.active,
            (u.password_hash is not null) has_password,
            exists (select 1 from kam.external_identity x where x.user_id = u.id) sso,
            coalesce((select array_agg(ur.role_id) from kam.user_business_role ur where ur.client_id = m.client_id and ur.user_id = u.id), '{}') role_ids,
            coalesce((select array_agg(ub.brand_id) from kam.user_brand ub where ub.client_id = m.client_id and ub.user_id = u.id), '{}') brand_ids,
            (select json_build_object('id', mg.id, 'manager_id', mg.manager_id, 'name', mu.display_name, 'from', lower(mg.valid))
               from kam.user_manager mg join kam.app_user mu on mu.id = mg.manager_id
              where mg.client_id = m.client_id and mg.user_id = u.id and mg.valid @> current_date) manager,
            coalesce((select json_agg(json_build_object('id', ka.id, 'network_id', ka.network_id, 'network_name', n.name,
                       'from', lower(ka.valid), 'to', upper(ka.valid) - 1) order by n.name)
               from kam.kam_assignment ka join kam.network n on n.client_id = ka.client_id and n.id = ka.network_id
              where ka.client_id = m.client_id and ka.user_id = u.id and (upper_inf(ka.valid) or upper(ka.valid) > current_date)), '[]') assignments
       from kam.membership m join kam.app_user u on u.id = m.user_id
      where m.client_id = $1 order by not m.active, u.display_name`, [ctx.clientId]);
  return { items: rows.map((r) => ({ ...r, me: r.id === ctx.principal.userId })) };
}

async function roleIds(tx: Tx, ctx: Ctx, v: unknown): Promise<string[]> {
  if (!Array.isArray(v) || !v.every(isUuid)) throw invalid('role_ids', 'Укажите роли.');
  const ids = [...new Set(v)];
  const { rows } = await tx.query<{ id: string }>('select id from kam.business_role where client_id=$1 and not archived and id = any($2::uuid[])', [ctx.clientId, ids]);
  if (rows.length !== ids.length) throw invalid('role_ids', 'Роль не найдена или в архиве.');
  return ids;
}

/** Пригласить по адресу. Новой учётной записи выдаётся временный пароль (показывается один раз). */
export async function inviteUser(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw invalid('email', 'Укажите адрес почты.');
  const name = text(b.display_name, 'display_name', 120, true);
  const roles = await roleIds(tx, ctx, b.role_ids ?? []);
  let user = (await tx.query<{ id: string }>('select id from kam.app_user where email=$1', [email])).rows[0];
  let tempPassword: string | null = null;
  if (!user) {
    if (!name) throw required('display_name', 'Укажите имя сотрудника.');
    tempPassword = temporaryPassword();
    user = { id: randomUUID() };
    await tx.query('insert into kam.app_user(id, email, display_name, password_hash, must_change_password) values ($1,$2,$3,$4,true)',
      [user.id, email, name, await hashPassword(tempPassword)]);
  }
  const m = (await tx.query('select active from kam.membership where client_id=$1 and user_id=$2', [ctx.clientId, user.id])).rows[0];
  if (m?.active) throw new ApiError(422, 'ALREADY_MEMBER', 'Сотрудник уже есть в списке.', {}, 'email');
  if (m) await tx.query('update kam.membership set active=true where client_id=$1 and user_id=$2', [ctx.clientId, user.id]);
  else await tx.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [ctx.clientId, user.id]);
  for (const r of roles) await tx.query('insert into kam.user_business_role(client_id, user_id, role_id) values ($1,$2,$3) on conflict do nothing', [ctx.clientId, user.id, r]);
  await audit(tx, ctx, { entityType: 'user', entityId: user.id, action: 'INVITE', after: { email, role_ids: roles } });
  return { status: 201, body: { id: user.id, temporary_password: tempPassword } };
}

async function lockMember(tx: Tx, ctx: Ctx, userId: string) {
  if (!isUuid(userId)) throw notFound();
  const m = (await tx.query<{ active: boolean }>('select active from kam.membership where client_id=$1 and user_id=$2 for update', [ctx.clientId, userId])).rows[0];
  if (!m) throw notFound();
  return m;
}

/** Роли, бренды и активность сотрудника в клиенте. */
export async function updateUser(tx: Tx, ctx: Ctx, userId: string, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const m = await lockMember(tx, ctx, userId);
  const after: Record<string, unknown> = {};
  if (b.role_ids !== undefined) {
    const roles = await roleIds(tx, ctx, b.role_ids);
    await tx.query('delete from kam.user_business_role where client_id=$1 and user_id=$2', [ctx.clientId, userId]);
    for (const r of roles) await tx.query('insert into kam.user_business_role(client_id, user_id, role_id) values ($1,$2,$3)', [ctx.clientId, userId, r]);
    after.role_ids = roles;
  }
  if (b.brand_ids !== undefined) {
    if (!Array.isArray(b.brand_ids) || !b.brand_ids.every(isUuid)) throw invalid('brand_ids', 'Некорректный список брендов.');
    const ids = [...new Set(b.brand_ids)];
    const ok = await tx.query('select id from kam.brand where client_id=$1 and id = any($2::uuid[])', [ctx.clientId, ids]);
    if (ok.rowCount !== ids.length) throw invalid('brand_ids', 'Бренд не найден.');
    await tx.query('delete from kam.user_brand where client_id=$1 and user_id=$2', [ctx.clientId, userId]);
    for (const id of ids) await tx.query('insert into kam.user_brand(client_id, user_id, brand_id) values ($1,$2,$3)', [ctx.clientId, userId, id]);
    after.brand_ids = ids;
  }
  if (b.active !== undefined) {
    const active = Boolean(b.active);
    if (!active && userId === ctx.principal.userId) throw new ApiError(422, 'SELF_DISABLE', 'Нельзя отключить себя.');
    if (active !== m.active) await tx.query('update kam.membership set active=$3 where client_id=$1 and user_id=$2', [ctx.clientId, userId, active]);
    after.active = active;
  }
  await ensureOtherAdmin(tx, ctx, {});
  await audit(tx, ctx, { entityType: 'user', entityId: userId, action: 'UPDATE', after });
  return { status: 200, body: { id: userId } };
}

export async function resetPassword(tx: Tx, ctx: Ctx, userId: string): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  await lockMember(tx, ctx, userId);
  const temp = temporaryPassword();
  await tx.query('update kam.app_user set password_hash=$2, must_change_password=true where id=$1', [userId, await hashPassword(temp)]);
  await tx.query("delete from kam.session where user_id=$1 and via='PASSWORD'", [userId]);
  await audit(tx, ctx, { entityType: 'user', entityId: userId, action: 'RESET_PASSWORD' });
  return { status: 200, body: { temporary_password: temp } };
}

/** Руководитель сотрудника с даты: текущая запись закрывается накануне, новая действует с даты. Пустой руководитель — снять. */
export async function setManager(tx: Tx, ctx: Ctx, userId: string, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  await lockMember(tx, ctx, userId);
  const from = date(b.from, 'from', true) ?? today();
  const managerId = b.manager_id === null || b.manager_id === undefined || b.manager_id === '' ? null : b.manager_id;
  if (managerId !== null) {
    if (!isUuid(managerId)) throw invalid('manager_id', 'Выберите руководителя.');
    if (managerId === userId) throw invalid('manager_id', 'Сотрудник не может быть своим руководителем.');
    await lockMember(tx, ctx, managerId);
    // Цикл в цепочке: руководитель не может быть подчинённым сотрудника.
    const { rowCount } = await tx.query(
      `with recursive up(id, depth) as (select $2::uuid, 0 union
         select m.manager_id, up.depth + 1 from kam.user_manager m join up on m.user_id = up.id
          where m.client_id = $1 and m.valid @> $4::date and up.depth < 30)
       select 1 from up where id = $3`, [ctx.clientId, managerId, userId, from]);
    if (rowCount) throw invalid('manager_id', 'Руководитель находится в подчинении у сотрудника — получится замкнутая цепочка.', 'MANAGER_CYCLE');
  }
  await tx.query(
    `update kam.user_manager set valid = daterange(lower(valid), $3::date, '[)')
      where client_id=$1 and user_id=$2 and valid @> $3::date and lower(valid) < $3::date`, [ctx.clientId, userId, from]);
  await tx.query(`delete from kam.user_manager where client_id=$1 and user_id=$2 and lower(valid) >= $3::date`, [ctx.clientId, userId, from]);
  if (managerId) {
    await tx.query(`insert into kam.user_manager(client_id, id, user_id, manager_id, valid) values ($1,$2,$3,$4, daterange($5::date, null, '[)'))`,
      [ctx.clientId, randomUUID(), userId, managerId, from]);
  }
  await audit(tx, ctx, { entityType: 'user', entityId: userId, action: 'SET_MANAGER', after: { manager_id: managerId, from } });
  return { status: 200, body: { id: userId } };
}

export async function addAssignment(tx: Tx, ctx: Ctx, userId: string, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  await lockMember(tx, ctx, userId);
  if (!isUuid(b.network_id)) throw required('network_id', 'Выберите сеть.');
  const from = date(b.from, 'from', true) ?? today();
  const to = date(b.to, 'to', true);
  if (to && to < from) throw invalid('to', 'Окончание раньше начала.');
  // Два администратора могут назначать одну сеть одновременно. Второй увидит имя первого назначенного КАМа.
  const { rows: [network] } = await tx.query<{ name: string }>(
    'select name from kam.network where client_id=$1 and id=$2 and not archived for update', [ctx.clientId, b.network_id]);
  if (!network) throw invalid('network_id', 'Сеть не найдена.');
  const { rows: [holder] } = await tx.query<{ user_id: string; display_name: string; ended: boolean }>(
    `select a.user_id, u.display_name, coalesce(upper(a.valid) <= current_date, false) as ended
       from kam.kam_assignment a join kam.app_user u on u.id = a.user_id
      where a.client_id=$1 and a.network_id=$2 and a.valid && daterange($3::date, $4::date, '[]')
      order by lower(a.valid) limit 1`, [ctx.clientId, b.network_id, from, to]);
  if (holder) {
    if (holder.user_id === userId) throw invalid('network_id', 'Сотрудник уже закреплён за этой сетью на эти даты.', 'PERIOD_OVERLAP');
    const next = holder.ended ? 'Выберите даты после окончания этого закрепления.' : 'Сначала открепите сеть в карточке этого сотрудника.';
    throw new ApiError(409, 'NETWORK_ALREADY_ASSIGNED',
      `На выбранные даты сеть «${network.name}» уже закреплена. Ответственный КАМ — ${holder.display_name}. ${next}`,
      { user_id: holder.user_id, display_name: holder.display_name }, 'network_id');
  }
  const id = randomUUID();
  await tx.query(`insert into kam.kam_assignment(client_id, id, user_id, network_id, valid) values ($1,$2,$3,$4, daterange($5::date, $6::date, '[]'))`,
    [ctx.clientId, id, userId, b.network_id, from, to]);
  await audit(tx, ctx, { entityType: 'assignment', entityId: id, action: 'CREATE', after: { user_id: userId, network_id: b.network_id, from, to } });
  return { status: 201, body: { id } };
}

/** С указанного дня сеть свободна. По умолчанию — с сегодняшнего дня. */
export async function endAssignment(tx: Tx, ctx: Ctx, assignmentId: string, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(assignmentId)) throw notFound();
  const requested = date(b.from, 'from', true);
  await tx.query(
    `select n.id from kam.kam_assignment a join kam.network n on n.client_id=a.client_id and n.id=a.network_id
      where a.client_id=$1 and a.id=$2 for update of n`, [ctx.clientId, assignmentId]);
  const { rows: [a] } = await tx.query<{ network_id: string; user_id: string; start: string; end_exclusive: string | null; today: string }>(
    `select network_id, user_id, lower(valid) as start, upper(valid) as end_exclusive, current_date as today
       from kam.kam_assignment where client_id=$1 and id=$2 for update`, [ctx.clientId, assignmentId]);
  if (!a) throw notFound();
  const from = requested ?? a.today;
  if (from < a.today) throw invalid('from', 'Выберите сегодня или будущую дату открепления.');
  if (a.end_exclusive && a.end_exclusive <= from) return { status: 200, body: { id: assignmentId } };
  if (from <= a.start) await tx.query('delete from kam.kam_assignment where client_id=$1 and id=$2', [ctx.clientId, assignmentId]);
  else await tx.query(`update kam.kam_assignment set valid = daterange(lower(valid), $3::date, '[)') where client_id=$1 and id=$2`, [ctx.clientId, assignmentId, from]);
  await audit(tx, ctx, { entityType: 'assignment', entityId: assignmentId, action: 'END',
    before: { network_id: a.network_id, user_id: a.user_id, from: a.start, end_exclusive: a.end_exclusive }, after: { released_from: from } });
  return { status: 200, body: { id: assignmentId } };
}

// Сети и юрлица -------------------------------------------------------------

export async function listNetworks(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const { rows } = await ctx.db.query(
    `select n.id, n.name, n.regions, n.group_id, g.name group_name, n.archived,
            coalesce((select json_agg(json_build_object('id', le.id, 'inn', le.inn, 'name', le.name, 'active', le.active) order by le.name)
               from kam.legal_entity le where le.client_id = n.client_id and le.network_id = n.id), '[]') legal_entities,
            coalesce((select json_agg(json_build_object('user_id', u.id, 'name', u.display_name) order by u.display_name)
               from kam.kam_assignment ka join kam.app_user u on u.id = ka.user_id
              where ka.client_id = n.client_id and ka.network_id = n.id and ka.valid @> current_date), '[]') kams,
            (select count(*)::int from kam.campaign c where c.client_id = n.client_id and c.network_id = n.id) campaigns
       from kam.network n left join kam.network_group g on g.client_id = n.client_id and g.id = n.group_id
      where n.client_id = $1 order by n.archived, n.name`, [ctx.clientId]);
  const { rows: groups } = await ctx.db.query('select id, name from kam.network_group where client_id=$1 order by name', [ctx.clientId]);
  return { items: rows, groups };
}

function regionsOf(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((r) => typeof r === 'string')) throw invalid('regions', 'Некорректный список регионов.');
  return [...new Set(v.map((r: string) => r.trim()).filter(Boolean))].slice(0, 100);
}

export async function saveNetwork(tx: Tx, ctx: Ctx, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const name = text(b.name, 'name', 200);
  const regions = regionsOf(b.regions);
  const groupId = b.group_id ? b.group_id : null;
  if (groupId !== null && !isUuid(groupId)) throw invalid('group_id', 'Группа не найдена.');
  if (id === null) {
    const nid = randomUUID();
    await tx.query('insert into kam.network(client_id, id, name, regions, group_id) values ($1,$2,$3,$4,$5)', [ctx.clientId, nid, name, regions, groupId]);
    await audit(tx, ctx, { entityType: 'network', entityId: nid, action: 'CREATE', after: { name, regions, group_id: groupId } });
    return { status: 201, body: { id: nid } };
  }
  if (!isUuid(id)) throw notFound();
  const before = (await tx.query('select name, regions, group_id, archived from kam.network where client_id=$1 and id=$2 for update', [ctx.clientId, id])).rows[0];
  if (!before) throw notFound();
  const archived = b.archived === undefined ? before.archived : Boolean(b.archived);
  await tx.query('update kam.network set name=$3, regions=$4, group_id=$5, archived=$6 where client_id=$1 and id=$2', [ctx.clientId, id, name, regions, groupId, archived]);
  await audit(tx, ctx, { entityType: 'network', entityId: id, action: 'UPDATE', before, after: { name, regions, group_id: groupId, archived } });
  return { status: 200, body: { id } };
}

export async function saveGroup(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const name = text(b.name, 'name', 120);
  const id = randomUUID();
  await tx.query('insert into kam.network_group(client_id, id, name) values ($1,$2,$3)', [ctx.clientId, id, name]);
  await audit(tx, ctx, { entityType: 'network_group', entityId: id, action: 'CREATE', after: { name } });
  return { status: 201, body: { id } };
}

export async function saveLegalEntity(tx: Tx, ctx: Ctx, networkId: string, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(networkId)) throw notFound();
  const net = (await tx.query('select 1 from kam.network where client_id=$1 and id=$2', [ctx.clientId, networkId])).rowCount;
  if (!net) throw notFound();
  const name = text(b.name, 'name', 250);
  if (id === null) {
    const inn = typeof b.inn === 'string' ? b.inn.replace(/\s/g, '') : '';
    if (!innValid(inn)) throw invalid('inn', 'ИНН должен содержать 10 или 12 цифр с верным контрольным числом.');
    const lid = randomUUID();
    await tx.query('insert into kam.legal_entity(client_id, id, network_id, inn, name) values ($1,$2,$3,$4,$5)', [ctx.clientId, lid, networkId, inn, name]);
    await audit(tx, ctx, { entityType: 'legal_entity', entityId: lid, action: 'CREATE', after: { network_id: networkId, inn, name } });
    return { status: 201, body: { id: lid } };
  }
  if (!isUuid(id)) throw notFound();
  const before = (await tx.query('select inn, name, active from kam.legal_entity where client_id=$1 and id=$2 and network_id=$3 for update', [ctx.clientId, id, networkId])).rows[0];
  if (!before) throw notFound();
  const active = b.active === undefined ? before.active : Boolean(b.active);
  await tx.query('update kam.legal_entity set name=$3, active=$4 where client_id=$1 and id=$2', [ctx.clientId, id, name, active]);
  await audit(tx, ctx, { entityType: 'legal_entity', entityId: id, action: 'UPDATE', before, after: { name, active } });
  return { status: 200, body: { id } };
}

// Бренды и типы кампаний ----------------------------------------------------

export async function listBrands(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const { rows } = await ctx.db.query('select id, name, archived from kam.brand where client_id=$1 order by archived, name', [ctx.clientId]);
  return { items: rows };
}

export async function saveBrand(tx: Tx, ctx: Ctx, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const name = text(b.name, 'name', 120);
  if (id === null) {
    const bid = randomUUID();
    await tx.query('insert into kam.brand(client_id, id, name) values ($1,$2,$3)', [ctx.clientId, bid, name]);
    await audit(tx, ctx, { entityType: 'brand', entityId: bid, action: 'CREATE', after: { name } });
    return { status: 201, body: { id: bid } };
  }
  if (!isUuid(id)) throw notFound();
  const before = (await tx.query('select name, archived from kam.brand where client_id=$1 and id=$2 for update', [ctx.clientId, id])).rows[0];
  if (!before) throw notFound();
  const archived = b.archived === undefined ? before.archived : Boolean(b.archived);
  await tx.query('update kam.brand set name=$3, archived=$4 where client_id=$1 and id=$2', [ctx.clientId, id, name, archived]);
  await audit(tx, ctx, { entityType: 'brand', entityId: id, action: 'UPDATE', before, after: { name, archived } });
  return { status: 200, body: { id } };
}

export const PERIOD_SPLITS = ['MONTH', 'QUARTER', 'FOUR_MONTHS', 'WHOLE'] as const;

export async function listTypes(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const { rows } = await ctx.db.query('select id, name, period_split, control_days, archived, sort_order from kam.campaign_type where client_id=$1 order by archived, sort_order, name', [ctx.clientId]);
  return { items: rows };
}

export async function saveType(tx: Tx, ctx: Ctx, id: string | null, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const name = text(b.name, 'name', 120);
  if (!(PERIOD_SPLITS as readonly string[]).includes(b.period_split as string)) throw invalid('period_split', 'Выберите деление периода.');
  const days = Number(b.control_days ?? 14);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw invalid('control_days', 'От 0 до 365 дней.');
  const sort = Number.isInteger(b.sort_order) ? Number(b.sort_order) : 0;
  if (id === null) {
    const tid = randomUUID();
    await tx.query('insert into kam.campaign_type(client_id, id, name, period_split, control_days, sort_order) values ($1,$2,$3,$4,$5,$6)',
      [ctx.clientId, tid, name, b.period_split, days, sort]);
    await audit(tx, ctx, { entityType: 'campaign_type', entityId: tid, action: 'CREATE', after: { name, period_split: b.period_split, control_days: days } });
    return { status: 201, body: { id: tid } };
  }
  if (!isUuid(id)) throw notFound();
  const before = (await tx.query('select name, period_split, control_days, archived from kam.campaign_type where client_id=$1 and id=$2 for update', [ctx.clientId, id])).rows[0];
  if (!before) throw notFound();
  // Деление периода задаёт столбцы разбивки версий: менять его у используемого типа нельзя.
  if (before.period_split !== b.period_split) {
    const used = (await tx.query('select 1 from kam.campaign where client_id=$1 and type_id=$2 limit 1', [ctx.clientId, id])).rowCount;
    if (used) throw invalid('period_split', 'Тип уже используется в кампаниях — деление периода менять нельзя. Создайте новый тип.', 'TYPE_IN_USE');
  }
  const archived = b.archived === undefined ? before.archived : Boolean(b.archived);
  await tx.query('update kam.campaign_type set name=$3, period_split=$4, control_days=$5, archived=$6, sort_order=$7 where client_id=$1 and id=$2',
    [ctx.clientId, id, name, b.period_split, days, archived, sort]);
  await audit(tx, ctx, { entityType: 'campaign_type', entityId: id, action: 'UPDATE', before, after: { name, period_split: b.period_split, control_days: days, archived } });
  return { status: 200, body: { id } };
}

// Журнал --------------------------------------------------------------------

export async function listAudit(ctx: Ctx, q: { entity_type?: string; before?: string }) {
  requirePermission(ctx, 'ADMIN');
  const params: unknown[] = [ctx.clientId];
  let where = 'a.client_id = $1';
  if (q.entity_type && /^[a-z_]{1,40}$/.test(q.entity_type)) { params.push(q.entity_type); where += ` and a.entity_type = $${params.length}`; }
  if (q.before && !Number.isNaN(Date.parse(q.before))) { params.push(q.before); where += ` and a.recorded_at < $${params.length}`; }
  const { rows } = await ctx.db.query(
    `select a.id, a.entity_type, a.entity_id, a.action, a.before, a.after, a.reason, a.recorded_at, u.display_name actor_name
       from kam.audit_event a join kam.app_user u on u.id = a.actor where ${where} order by a.recorded_at desc limit 200`, params);
  return { items: rows };
}
