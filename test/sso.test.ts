import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setup, api, C, type TestEnv } from './helpers.js';
import { signToken } from '../src/sso.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const claims = (o: Record<string, unknown> = {}) => ({ iss: 'test-platform', aud: 'pharmacheck-kam', sub: 'platform-user-1', email: 'anna.smirnova@demo.test', name: 'Анна Смирнова', client: 'DEMO', ...o });
const sso = (token: string, embed = true) => env.app.inject({ method: 'GET', url: `/sso?token=${encodeURIComponent(token)}${embed ? '&embed=1' : ''}` });

test('сценарий 16: токен платформы открывает модуль во встроенном режиме и создаёт сессию', async () => {
  const res = await sso(signToken(env.keys.privatePem, claims()));
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /^\/\?client=[0-9a-f-]{36}&embed=1$/);
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /kam_session=.+HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const token = /kam_session=([^;]+)/.exec(cookie)![1]!;
  env.tokens.sso = token;
  const me = (await call('/api/kam/v1/me', { as: 'sso' })).json;
  assert.equal(me.email, 'anna.smirnova@demo.test', 'пользователь найден по почте и связан с идентификатором платформы');
  assert.equal(me.via, 'SSO');
  assert.equal(me.companies[0].code, 'DEMO');
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'sso' })).status, 200);
});

test('повтор того же токена отклоняется', async () => {
  const t = signToken(env.keys.privatePem, claims());
  assert.equal((await sso(t)).statusCode, 303);
  const again = await sso(t);
  assert.equal(again.statusCode, 401);
  assert.match(again.body, /Не удалось открыть переговоры/);
});

test('чужая подпись, просроченный, слишком долгий, другой адресат — отклоняются', async () => {
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal((await sso(signToken(other, claims()))).statusCode, 401);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await sso(signToken(env.keys.privatePem, { ...claims(), iat: now - 600, exp: now - 540 }))).statusCode, 401);
  assert.equal((await sso(signToken(env.keys.privatePem, { ...claims(), iat: now, exp: now + 3600 }))).statusCode, 401);
  assert.equal((await sso(signToken(env.keys.privatePem, claims({ aud: 'other-module' })))).statusCode, 401);
  assert.equal((await sso('not.a.token')).statusCode, 401);
});

test('новый пользователь платформы создаётся автоматически без ролей; неизвестная компания — 403', async () => {
  const res = await sso(signToken(env.keys.privatePem, claims({ sub: 'new-1', email: 'new.person@demo.test', name: 'Новый Сотрудник' })));
  assert.equal(res.statusCode, 303);
  env.tokens.newbie = /kam_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
  const me = (await call('/api/kam/v1/me', { as: 'newbie' })).json;
  assert.deepEqual(me.companies[0].permissions, []);
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'newbie' })).json.items.length, 0);
  const unknown = await sso(signToken(env.keys.privatePem, claims({ sub: 'x', client: 'NOPE' })));
  assert.equal(unknown.statusCode, 403);
});

test('встраивание разрешено только адресам платформы; демо-платформа закрыта паролем стенда', async () => {
  const res = await env.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self' https://app.truedata.tech");
  assert.equal((await env.app.inject({ method: 'GET', url: '/demo-platform' })).statusCode, 401);
  const auth = 'Basic ' + Buffer.from('demo:stand-pass').toString('base64');
  const page = await env.app.inject({ method: 'GET', url: '/demo-platform', headers: { authorization: auth } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Анна Смирнова/);
  const tok = await env.app.inject({ method: 'POST', url: '/demo-platform/token', headers: { authorization: auth }, payload: { email: 'olga.morozova@demo.test' } });
  const open = await env.app.inject({ method: 'GET', url: tok.json().url });
  assert.equal(open.statusCode, 303);
});

test('исправленное ФИО видно в кампаниях своей компании и сохраняется при повторном входе из платформы', async () => {
  const email = 'dmitry.petrov@demo.test';
  const fullName = 'Петров Дмитрий Игоревич';
  const platformUser = claims({ sub: 'employee-petrov', email, name: 'DEV account' });
  const enter = async () => {
    const res = await sso(signToken(env.keys.privatePem, platformUser));
    assert.equal(res.statusCode, 303);
    env.tokens.employee = res.cookies.find((c) => c.name === 'kam_session')!.value;
    return (await call('/api/kam/v1/me', { as: 'employee' })).json;
  };
  const previous = await enter();
  const id = previous.user_id;
  const url = `${C(env)}/users/${id}`;
  const patch = (body: object, as = 'admin') => call(url, { as, method: 'PATCH', body });
  assert.equal((await patch({ display_name: fullName }, 'employee')).status, 403);
  for (const display_name of ['   ', 'а'.repeat(121)]) {
    assert.equal((await patch({ display_name })).json.error.field, 'display_name');
  }
  assert.equal((await patch({ email: 'new@demo.test', display_name: fullName })).json.error.field, 'email');
  const before = (await call(`${C(env)}/campaigns`, { as: 'employee' })).json.items;
  assert.ok(before.length > 0);
  assert.equal((await patch({ display_name: '  Петров  Дмитрий Игоревич  ' })).status, 200);
  const again = await enter();
  assert.equal(again.user_id, id);
  assert.equal(again.email, email);
  assert.equal(again.display_name, fullName);
  assert.deepEqual(again.companies[0].roles, previous.companies[0].roles);
  const after = (await call(`${C(env)}/campaigns`, { as: 'employee' })).json.items;
  assert.deepEqual(after.map((c: { id: string }) => c.id).sort(), before.map((c: { id: string }) => c.id).sort());
  assert.ok(after.every((c: { owner_name: string }) => c.owner_name === fullName));
  const card = (await call(`${C(env)}/campaigns/${after[0].id}`, { as: 'employee' })).json;
  assert.deepEqual(card.owner, { id, name: fullName, email });
  const events = (await call(`${C(env)}/audit`, { as: 'admin', query: { entity_type: 'user' } })).json.items;
  const rename = events.find((e: { entity_id: string; action: string }) => e.entity_id === id && e.action === 'UPDATE');
  assert.deepEqual(rename.before, { display_name: previous.display_name });
  assert.deepEqual(rename.after, { display_name: fullName });

  await env.db.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [env.other, id]);
  const otherList = (await call(`${C(env, env.other)}/users`, { as: 'admin@other.test' })).json.items;
  assert.equal(otherList.find((u: { id: string }) => u.id === id).display_name, previous.display_name);
  const me = await enter();
  assert.equal(me.companies.find((c: { id: string }) => c.id === env.demo).display_name, fullName);
  assert.equal(me.companies.find((c: { id: string }) => c.id === env.other).display_name, previous.display_name);
});
