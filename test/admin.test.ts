import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, api, C, type TestEnv } from './helpers.js';
import { innValid } from '../src/admin.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const userId = async (login: string) => (await env.db.query<{ id: string }>('select id from kam.app_user where email=$1', [`${login}@demo.test`])).rows[0]!.id;

test('администрирование доступно только с полномочием «Администрировать»', async () => {
  for (const path of ['roles', 'users', 'networks', 'brands', 'campaign-types', 'audit']) {
    assert.equal((await call(`${C(env)}/${path}`, { as: 'anna.smirnova' })).status, 403, path);
    assert.equal((await call(`${C(env)}/${path}`, { as: 'admin' })).status, 200, path);
  }
});

test('сценарий 2: новая роль в конструкторе сразу даёт права', async () => {
  const role = await call(`${C(env)}/roles`, { as: 'admin', body: { name: 'Коммерческий директор', permissions: ['APPROVE', 'ANALYTICS'], scope: 'ALL' } });
  assert.equal(role.status, 201);
  const dup = await call(`${C(env)}/roles`, { as: 'admin', body: { name: 'коммерческий директор', permissions: ['APPROVE'], scope: 'ALL' } });
  assert.equal(dup.status, 422);
  const bad = await call(`${C(env)}/roles`, { as: 'admin', body: { name: 'X', permissions: ['ROOT'], scope: 'ALL' } });
  assert.equal(bad.json.error.field, 'permissions');

  const invite = await call(`${C(env)}/users`, { as: 'admin', body: { email: 'new.director@demo.test', display_name: 'Новый Директор', role_ids: [role.json.id] } });
  assert.equal(invite.status, 201);
  assert.match(invite.json.temporary_password, /^[A-Za-z0-9]{16}$/);
  // Вход по временному паролю: до смены доступно только чтение.
  const login = await env.app.inject({ method: 'POST', url: '/api/kam/v1/auth/login', payload: { email: 'new.director@demo.test', password: invite.json.temporary_password } });
  assert.equal(login.json().must_change_password, true);
  env.tokens.dir = login.json().token;
  const me = (await call('/api/kam/v1/me', { as: 'dir' })).json;
  assert.deepEqual(me.companies[0].permissions, ['ANALYTICS', 'APPROVE']);
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'dir' })).json.items.length, 78, 'область «все сети»');
  const blocked = await call(`${C(env)}/campaigns`, { as: 'dir', body: {} });
  assert.equal(blocked.json.error.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('оргструктура: смена руководителя меняет видимость; цикл запрещён', async () => {
  const dmitry = await userId('dmitry.petrov');
  const sergey = await userId('sergey.volkov');
  const before = (await call(`${C(env)}/campaigns`, { as: 'sergey.volkov' })).json.items.length;
  const moved = await call(`${C(env)}/users/${dmitry}/manager`, { as: 'admin', method: 'PUT', body: { manager_id: sergey } });
  assert.equal(moved.status, 200, moved.body);
  const after = (await call(`${C(env)}/campaigns`, { as: 'sergey.volkov' })).json.items.length;
  assert.ok(after > before, 'кампании сетей Дмитрия видны новому руководителю');
  const cycle = await call(`${C(env)}/users/${sergey}/manager`, { as: 'admin', method: 'PUT', body: { manager_id: dmitry } });
  assert.equal(cycle.json.error.code, 'MANAGER_CYCLE');
});

test('закрепление за сетью: добавить и завершить; пересечение запрещено', async () => {
  const ilya = await userId('ilya.ivanov');
  const network = (await env.db.query<{ id: string }>("select id from kam.network where name='Озерки'")).rows[0]!.id;
  const add = await call(`${C(env)}/users/${ilya}/assignments`, { as: 'admin', body: { network_id: network } });
  assert.equal(add.status, 201);
  const dup = await call(`${C(env)}/users/${ilya}/assignments`, { as: 'admin', body: { network_id: network } });
  assert.equal(dup.json.error.code, 'PERIOD_OVERLAP');
  const refs = (await call(`${C(env)}/reference`, { as: 'ilya.ivanov' })).json;
  assert.ok(refs.networks.some((n: any) => n.name === 'Озерки'));
  assert.equal((await call(`${C(env)}/assignments/${add.json.id}/end`, { as: 'admin', body: {} })).status, 200);
  const refs2 = (await call(`${C(env)}/reference`, { as: 'ilya.ivanov' })).json;
  assert.ok(!refs2.networks.some((n: any) => n.name === 'Озерки'));
});

test('нельзя оставить клиента без администратора', async () => {
  const adminRole = (await env.db.query<{ id: string }>("select id from kam.business_role where client_id=$1 and name='Администратор'", [env.demo])).rows[0]!.id;
  const r = await call(`${C(env)}/roles/${adminRole}`, { as: 'admin', method: 'PUT', body: { name: 'Администратор', permissions: ['ANALYTICS'], scope: 'ALL' } });
  assert.equal(r.json.error.code, 'LAST_ADMIN');
  const self = await call(`${C(env)}/users/${await userId('admin')}`, { as: 'admin', method: 'PATCH', body: { role_ids: [] } });
  assert.equal(self.json.error.code, 'LAST_ADMIN');
});

test('сети и юрлица: проверка ИНН, дубль ИНН, журнал', async () => {
  assert.ok(innValid('7707083893'));
  assert.ok(!innValid('7707083894'));
  assert.ok(innValid('500100732259'));
  const net = await call(`${C(env)}/networks`, { as: 'admin', body: { name: 'Новая сеть', regions: ['Тульская область'] } });
  assert.equal(net.status, 201);
  const bad = await call(`${C(env)}/networks/${net.json.id}/legal-entities`, { as: 'admin', body: { inn: '1234567890', name: 'ООО «Новая сеть»' } });
  assert.equal(bad.json.error.field, 'inn');
  const ok = await call(`${C(env)}/networks/${net.json.id}/legal-entities`, { as: 'admin', body: { inn: '7707083893', name: 'ООО «Новая сеть»' } });
  assert.equal(ok.status, 201);
  const dup = await call(`${C(env)}/networks/${net.json.id}/legal-entities`, { as: 'admin', body: { inn: '7707083893', name: 'ООО «Дубль»' } });
  assert.equal(dup.json.error.code, 'DUPLICATE');
  const audit = (await call(`${C(env)}/audit`, { as: 'admin', query: { entity_type: 'legal_entity' } })).json.items;
  assert.ok(audit.some((a: any) => a.after?.inn === '7707083893'));
  // Журнал неизменяем.
  await assert.rejects(env.db.query('update kam.audit_event set action=$1', ['X']));
});

test('тип кампании: деление периода нельзя менять, если тип используется', async () => {
  const t = (await env.db.query<{ id: string }>("select id from kam.campaign_type where client_id=$1 and name='Годовые условия'", [env.demo])).rows[0]!.id;
  const r = await call(`${C(env)}/campaign-types/${t}`, { as: 'admin', method: 'PUT', body: { name: 'Годовые условия', period_split: 'MONTH', control_days: 30 } });
  assert.equal(r.json.error.code, 'TYPE_IN_USE');
  const ok = await call(`${C(env)}/campaign-types/${t}`, { as: 'admin', method: 'PUT', body: { name: 'Годовые условия', period_split: 'QUARTER', control_days: 45 } });
  assert.equal(ok.status, 200);
});

test('сброс пароля не даёт доступа к другой компании и не выдаёт пароль пользователю платформы', async () => {
  // Администратор DEMO приглашает сотрудника другой компании модуля: членство появляется, но пароль чужого сотрудника он не сбросит.
  const invite = await call(`${C(env)}/users`, { as: 'admin', body: { email: 'admin@other.test', display_name: 'Чужой', role_ids: [] } });
  assert.equal(invite.status, 201, invite.body);
  assert.equal(invite.json.temporary_password, null);
  const shared = await call(`${C(env)}/users/${invite.json.id}/password-reset`, { as: 'admin', body: {} });
  assert.equal(shared.status, 422);
  assert.equal(shared.json.error.code, 'USER_SHARED');
  await env.login('admin@other.test'); // прежний пароль действует

  // Пользователь, пришедший только из платформы, пароля модуля не получает.
  const sso = (await env.db.query<{ id: string }>("insert into kam.app_user(id, email, display_name) values (gen_random_uuid(), 'platform.only@demo.test', 'Из платформы') returning id")).rows[0]!.id;
  await env.db.query("insert into kam.external_identity(issuer, subject, user_id) values ('test-platform', 'p-1', $1)", [sso]);
  await env.db.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [env.demo, sso]);
  const ssoReset = await call(`${C(env)}/users/${sso}/password-reset`, { as: 'admin', body: {} });
  assert.equal(ssoReset.json.error.code, 'SSO_USER');

  // Сотрудник только этой компании — сброс работает.
  const own = await call(`${C(env)}/users`, { as: 'admin', body: { email: 'solo@demo.test', display_name: 'Свой', role_ids: [] } });
  const ok = await call(`${C(env)}/users/${own.json.id}/password-reset`, { as: 'admin', body: {} });
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.json.temporary_password, /^[A-Za-z0-9]{16}$/);
});
