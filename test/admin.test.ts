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

test('занятую сеть можно передать только после открепления у названного КАМа', async () => {
  const ilya = await userId('ilya.ivanov');
  const { rows: [initial] } = await env.db.query<{ id: string; network_id: string; user_id: string; name: string }>(
    `select a.id, a.network_id, a.user_id, u.display_name as name from kam.kam_assignment a
       join kam.network n on (n.client_id,n.id)=(a.client_id,a.network_id) join kam.app_user u on u.id=a.user_id
      where a.client_id=$1 and n.name='Озерки' and a.valid @> current_date`, [env.demo]);
  assert.ok(initial);
  const network = initial.network_id;
  const blocked = await call(`${C(env)}/users/${ilya}/assignments`, { as: 'admin', body: { network_id: network } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'NETWORK_ALREADY_ASSIGNED');
  assert.equal(blocked.json.error.field, 'network_id');
  assert.equal(blocked.json.error.details.user_id, initial.user_id);
  assert.ok(blocked.json.error.message.includes(initial.name));
  assert.match(blocked.json.error.message, /Сначала открепите сеть/);
  assert.equal((await call(`${C(env)}/assignments/${initial.id}/end`, { as: 'admin', body: {} })).status, 200);
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

test('конкурирующие назначения: один КАМ на сеть и дату в каждой компании', async () => {
  const net = await call(`${C(env)}/networks`, { as: 'admin', body: { name: 'Проверка закреплений' } });
  assert.equal(net.status, 201);
  const network = net.json.id;
  const kams = [await userId('ilya.ivanov'), await userId('tatiana.lebedeva')];
  const assign = (id: string, from: string, to: string) => call(`${C(env)}/users/${id}/assignments`,
    { as: 'admin', body: { network_id: network, from, to } });
  const results = await Promise.all(kams.map((id) => assign(id, '2090-05-01', '2090-05-15')));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const winner = results.findIndex((r) => r.status === 201);
  const loser = 1 - winner;
  assert.equal(results[loser]!.json.error.details.user_id, kams[winner]);
  assert.equal((await assign(kams[loser]!, '2090-05-15', '2090-05-19')).status, 409, 'последний день включён');
  assert.equal((await assign(kams[loser]!, '2090-05-16', '2090-05-19')).status, 201, 'последовательные периоды разрешены');

  const directInsert = (clientId: string, user: string) => env.db.query(
    `insert into kam.kam_assignment(client_id,id,user_id,network_id,valid)
     values ($1,gen_random_uuid(),$2,$3,daterange('2090-05-01','2090-05-15','[]'))`, [clientId, user, network]);
  await assert.rejects(directInsert(env.demo, kams[loser]!), { code: '23P01', constraint: 'kam_assignment_network_period_excl' });
  await env.db.query("insert into kam.network(client_id,id,name) values ($1,$2,'Сеть второго клиента')", [env.other, network]);
  const otherAdmin = (await env.db.query<{ id: string }>("select id from kam.app_user where email='admin@other.test'")).rows[0]!.id;
  assert.equal((await directInsert(env.other, otherAdmin)).rowCount, 1);
});

test('завершённое закрепление защищает свою историю и допускает последующую передачу', async () => {
  const net = await call(`${C(env)}/networks`, { as: 'admin', body: { name: 'История закреплений' } });
  const first = await userId('tatiana.lebedeva');
  const next = await userId('ilya.ivanov');
  const assign = (id: string, from: string, to: string) => call(`${C(env)}/users/${id}/assignments`,
    { as: 'admin', body: { network_id: net.json.id, from, to } });
  const old = await assign(first, '2020-01-01', '2020-01-19');
  assert.equal(old.status, 201);
  assert.equal((await call(`${C(env)}/assignments/${old.json.id}/end`, { as: 'admin', body: {} })).status, 200);
  const overlap = await assign(next, '2020-01-19', '2020-01-25');
  assert.equal(overlap.status, 409);
  assert.match(overlap.json.error.message, /Татьяна Лебедева/);
  assert.match(overlap.json.error.message, /после окончания/);
  assert.equal((await assign(next, '2020-01-20', '2020-01-25')).status, 201);
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
