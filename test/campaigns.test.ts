import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, api, C, type TestEnv } from './helpers.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const ref = async (as: string) => (await call(`${C(env)}/reference`, { as })).json;
const netId = async (name: string) => (await env.db.query<{ id: string }>('select id from kam.network where client_id=$1 and name=$2', [env.demo, name])).rows[0]!.id;
const typeId = async (name: string) => (await env.db.query<{ id: string }>('select id from kam.campaign_type where client_id=$1 and name=$2', [env.demo, name])).rows[0]!.id;
const userId = async (login: string) => (await env.db.query<{ id: string }>('select id from kam.app_user where email=$1', [`${login}@demo.test`])).rows[0]!.id;

test('сценарий 1: КАМ видит только кампании своих сетей; руководитель — подчинённых; финансовый директор — все', async () => {
  const all = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev' })).json.items.length;
  const anna = (await call(`${C(env)}/campaigns`, { as: 'anna.smirnova' })).json.items;
  const elena = (await call(`${C(env)}/campaigns`, { as: 'elena.sokolova' })).json.items;
  const olga = (await call(`${C(env)}/campaigns`, { as: 'olga.morozova' })).json.items;
  assert.equal(all, 78);
  assert.ok(anna.length > 0 && anna.every((c: any) => ['Ригла', 'АСНА', 'Мелодия здоровья'].includes(c.network_name)));
  assert.ok(elena.length > anna.length && elena.length < all);
  assert.equal(olga.length, all, 'национальный руководитель видит обе группы');
  // Карточка чужой кампании для КАМ — 404, а не 403: её существование не раскрывается.
  const foreign = (await env.db.query<{ id: string }>("select c.id from kam.campaign c join kam.network n on n.id=c.network_id where n.name='Магнит Аптека' limit 1")).rows[0]!.id;
  assert.equal((await call(`${C(env)}/campaigns/${foreign}`, { as: 'anna.smirnova' })).status, 404);
  assert.equal((await call(`${C(env)}/campaigns/${foreign}`, { as: 'sergey.volkov' })).status, 200);
});

test('пользователь другого клиента получает 404', async () => {
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'admin@other.test' })).status, 404);
  assert.equal((await call(`${C(env)}/reference`, { as: 'admin@other.test' })).status, 404);
  assert.equal((await call(`${C(env, randomUUID())}/campaigns`, { as: 'anna.smirnova' })).status, 404);
});

test('сценарий 3: по умолчанию в кампанию попадают все юрлица сети; снятое юрлицо не попадает', async () => {
  const network = await netId('Ригла');
  const type = await typeId('Ассортиментное соглашение');
  const ents = (await env.db.query<{ id: string }>('select id from kam.legal_entity where client_id=$1 and network_id=$2 order by name', [env.demo, network])).rows.map((r) => r.id);
  assert.ok(ents.length >= 2);
  const a = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, title: 'Ассортимент I полугодие', period_from: '2027-01-01', period_to: '2027-06-30' } });
  assert.equal(a.status, 201, a.body);
  const card = (await call(`${C(env)}/campaigns/${a.json.id}`, { as: 'anna.smirnova' })).json;
  assert.equal(card.legal_entities.filter((e: any) => e.selected).length, ents.length);
  assert.equal(card.control_date, '2026-12-18', 'контрольная дата по умолчанию — за 14 дней до начала');
  assert.equal(card.stage, 'PREPARATION');
  assert.ok(card.actions.includes('START_NEGOTIATION'));

  const b = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, title: 'Ассортимент II полугодие', period_from: '2027-07-01', period_to: '2027-12-31', legal_entity_ids: [ents[0]] } });
  assert.equal(b.status, 201);
  const cardB = (await call(`${C(env)}/campaigns/${b.json.id}`, { as: 'anna.smirnova' })).json;
  assert.deepEqual(cardB.legal_entities.filter((e: any) => e.selected).map((e: any) => e.id), [ents[0]]);

  const foreignEntity = (await env.db.query<{ id: string }>("select le.id from kam.legal_entity le join kam.network n on n.id=le.network_id where n.name='Озерки' limit 1")).rows[0]!.id;
  const bad = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, title: 'x', period_from: '2027-01-01', period_to: '2027-02-01', legal_entity_ids: [foreignEntity] } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.field, 'legal_entity_ids');
});

test('сценарий 4: годовая и акция одной сети существуют одновременно; пересечение двух годовых — предупреждение', async () => {
  const network = await netId('АСНА');
  const promo = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: await typeId('Разовая акция'), title: 'Майская акция', period_from: '2027-05-01', period_to: '2027-05-31' } });
  assert.equal(promo.status, 201);
  assert.deepEqual(promo.json.warnings, []);
  const annual = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: await typeId('Годовые условия'), title: 'Годовые условия 2027 (дубль)', period_from: '2027-01-01', period_to: '2027-12-31' } });
  assert.equal(annual.status, 201, 'пересечение не запрещено');
  assert.equal(annual.json.warnings[0].code, 'PERIOD_OVERLAP');
});

test('ответственный должен быть закреплён за сетью; назначить можно себя или подчинённого', async () => {
  const network = await netId('Магнит Аптека');
  const type = await typeId('Разовая акция');
  const body = { network_id: network, type_id: type, title: 'Акция', period_from: '2027-03-01', period_to: '2027-03-31' };
  const own = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body });
  assert.equal(own.status, 422);
  assert.equal(own.json.error.code, 'NETWORK_NOT_ASSIGNED');
  // Руководитель создаёт кампанию за своего КАМ.
  const forSub = await call(`${C(env)}/campaigns`, { as: 'sergey.volkov', body: { ...body, owner_id: await userId('ilya.ivanov') } });
  assert.equal(forSub.status, 201, forSub.body);
  // Руководитель другой группы — нельзя.
  const foreign = await call(`${C(env)}/campaigns`, { as: 'elena.sokolova', body: { ...body, owner_id: await userId('ilya.ivanov') } });
  assert.equal(foreign.status, 422);
  assert.equal(foreign.json.error.code, 'OWNER_NOT_ALLOWED');
  // Финансовый директор кампании не ведёт.
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', body })).status, 403);
});

test('проверки реквизитов: обязательные поля, даты, контрольная дата', async () => {
  const network = await netId('Ригла');
  const type = await typeId('Разовая акция');
  const r1 = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, period_from: '2027-03-01', period_to: '2027-03-31' } });
  assert.equal(r1.json.error.field, 'title');
  const r2 = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, title: 'x', period_from: '2027-03-31', period_to: '2027-03-01' } });
  assert.equal(r2.json.error.field, 'period_to');
  const r3 = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: { network_id: network, type_id: type, title: 'x', period_from: '2027-03-01', period_to: '2027-03-31', control_date: '2027-04-10' } });
  assert.equal(r3.json.error.field, 'control_date');
});

test('переход в переговоры, правка с If-Match, конфликт ревизий, отмена с причиной', async () => {
  const created = await call(`${C(env)}/campaigns`, { as: 'dmitry.petrov', body: { network_id: await netId('Неофарм'), type_id: await typeId('Разовая акция'), title: 'Акция лето', period_from: '2027-06-01', period_to: '2027-06-30' } });
  const url = `${C(env)}/campaigns/${created.json.id}`;
  const first = await call(url, { as: 'dmitry.petrov' });
  const etag = first.etag!;
  const moved = await call(`${url}/transitions`, { as: 'dmitry.petrov', ifMatch: etag, body: { action: 'START_NEGOTIATION' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.stage, 'NEGOTIATION');
  // Устаревшая форма не затирает правку.
  const stale = await call(url, { as: 'dmitry.petrov', method: 'PATCH', ifMatch: etag, body: { title: 'Новое название' } });
  assert.equal(stale.status, 412);
  const edit = await call(url, { as: 'dmitry.petrov', method: 'PATCH', ifMatch: moved.etag, body: { title: 'Акция лето 2027' } });
  assert.equal(edit.status, 200);
  // КАМ другой группы не видит кампанию, руководитель своей группы может отменить за КАМ.
  assert.equal((await call(`${url}/transitions`, { as: 'ilya.ivanov', ifMatch: edit.etag, body: { action: 'CANCEL', comment: 'x' } })).status, 404);
  const noReason = await call(`${url}/transitions`, { as: 'elena.sokolova', ifMatch: edit.etag, body: { action: 'CANCEL' } });
  assert.equal(noReason.status, 422);
  const cancel = await call(`${url}/transitions`, { as: 'elena.sokolova', ifMatch: edit.etag, body: { action: 'CANCEL', comment: 'Сеть перенесла акцию на осень.' } });
  assert.equal(cancel.status, 200);
  const card = (await call(url, { as: 'dmitry.petrov' })).json;
  assert.equal(card.stage, 'CANCELLED');
  assert.equal(card.cancel_reason, 'Сеть перенесла акцию на осень.');
  assert.deepEqual(card.events.map((e: any) => e.to_stage).slice(0, 2), ['CANCELLED', null]);
  // После отмены правка невозможна.
  const locked = await call(url, { as: 'dmitry.petrov', method: 'PATCH', ifMatch: cancel.etag, body: { title: 'x' } });
  assert.equal(locked.status, 409);
});

test('повтор команды с тем же Idempotency-Key не создаёт дубль', async () => {
  const key = randomUUID();
  const body = { network_id: await netId('Горздрав'), type_id: await typeId('Разовая акция'), title: 'Акция осень', period_from: '2027-09-01', period_to: '2027-09-30' };
  const a = await call(`${C(env)}/campaigns`, { as: 'maria.kuznetsova', key, body });
  const b = await call(`${C(env)}/campaigns`, { as: 'maria.kuznetsova', key, body });
  assert.equal(a.json.id, b.json.id);
  assert.equal(b.headers['idempotent-replay'], 'true');
  const c = await call(`${C(env)}/campaigns`, { as: 'maria.kuznetsova', key, body: { ...body, title: 'Другое' } });
  assert.equal(c.status, 409);
  assert.equal((await call(`${C(env)}/campaigns`, { as: 'maria.kuznetsova', key: null, body })).status, 428);
});

test('портфель: фильтры, просрочка, количество по этапам', async () => {
  const r = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', query: { year: '2027' } })).json;
  assert.ok(r.items.every((c: any) => c.period_to >= '2027-01-01' && c.period_from <= '2027-12-31'));
  const stages = r.kpi.by_stage;
  const filtered = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', query: { year: '2027', stage: 'APPROVAL' } })).json;
  assert.equal(filtered.items.length, stages.APPROVAL);
  assert.equal(filtered.kpi.by_stage.NEGOTIATION, stages.NEGOTIATION, 'счётчики этапов не зависят от фильтра этапа');
  const overdue = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', query: { overdue: '1' } })).json;
  assert.ok(overdue.items.length > 0 && overdue.items.every((c: any) => c.overdue));
  const search = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', query: { q: 'ригла' } })).json;
  assert.ok(search.items.length > 0 && search.items.every((c: any) => c.network_name === 'Ригла' || /ригла/i.test(c.title)));
  const refs = await ref('anna.smirnova');
  assert.deepEqual(refs.networks.map((n: any) => n.name).sort(), ['АСНА', 'Мелодия здоровья', 'Ригла']);
  assert.equal(refs.assignable.length, 1);
});
