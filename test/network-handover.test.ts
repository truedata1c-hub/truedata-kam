import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, C, multipart, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const previous = 'tatiana.lebedeva';
const successor = 'anna.smirnova';

async function holder(network: string) {
  const { rows } = await env.db.query<{ id: string; network_id: string; user_id: string }>(
    `select a.id,a.network_id,a.user_id from kam.kam_assignment a join kam.network n on n.client_id=a.client_id and n.id=a.network_id
      where a.client_id=$1 and n.name=$2 and a.valid @> current_date`, [env.demo, network]);
  return rows[0]!;
}

async function userId(login: string): Promise<string> {
  return (await env.db.query('select id from kam.app_user where email=$1', [login + '@demo.test'])).rows[0].id;
}

test('передача сети переносит весь портфель и рабочие действия, сохраняя версии, авторов и маршрут', async () => {
  const base = C(env);
  const old = await holder('Фармленд');
  const next = await userId(successor);
  const ref = (await call(base + '/reference', { as: previous })).json;
  const fields = { network_id: old.network_id, type_id: ref.types.find((t: { name: string }) => t.name === 'Годовые условия').id,
    title: 'Проверка передачи переговоров', period_from: '2027-01-01', period_to: '2027-12-31' };
  const created = await call(base + '/campaigns', { as: previous, body: fields });
  assert.equal(created.status, 201, created.body);
  const url = base + '/campaigns/' + created.json.id;
  const started = await call(url + '/transitions', { as: previous, ifMatch: created.etag, body: { action: 'START_NEGOTIATION' } });
  const draft = (await call(url + '/versions/draft', { as: previous })).json;
  const offer = { justification: 'Годовые условия сети', cells: [
    { brand_id: ref.brands[0].id, period_key: draft.periods[0].key, investment: 1500, turnover: 12000 }] };
  const first = await call(url + '/versions', { as: previous, ifMatch: started.etag, body: offer });
  assert.equal(first.status, 201, first.body);
  const sent = await call(url + '/approval/submit', { as: previous, ifMatch: first.etag, body: {} });
  assert.equal(sent.status, 201, sent.body);
  const original = (await call(url, { as: previous })).json;
  const frozen = (await call(url + '/approval', { as: previous })).json.current;
  const portfolio = (await call(base + '/campaigns', { as: previous, query: { network: old.network_id } })).json.items;
  const archived = portfolio.find((c: { stage: string }) => c.stage === 'CLOSED');
  assert.ok(archived);

  assert.equal((await call(base + '/assignments/' + old.id + '/end', { as: 'admin', body: {} })).status, 200);
  const gap = (await call(url, { as: 'admin' })).json;
  assert.deepEqual(gap.owner, { id: null, name: 'КАМ не назначен', email: null });
  assert.deepEqual(gap.actions, []);
  assert.equal((await call(url, { as: previous })).status, 404);
  assert.equal((await call(url, { as: successor })).status, 404);
  const inbox = (await call(base + '/my-decisions', { as: 'sergey.volkov' })).json.items;
  assert.ok(inbox.some((s: { campaign_id: string }) => s.campaign_id === created.json.id), 'согласующий сохраняет свой шаг даже между закреплениями');
  assert.equal((await call(base + '/users/' + next + '/assignments', { as: 'admin', body: { network_id: old.network_id } })).status, 201);

  const after = await call(url, { as: successor });
  assert.equal(after.json.owner.id, next);
  assert.deepEqual(after.json.events, original.events);
  assert.equal(after.json.created_by, original.created_by);
  const currentApproval = (await call(url + '/approval', { as: successor })).json;
  assert.deepEqual(currentApproval.current, frozen);
  assert.equal(currentApproval.my_decision, null);
  assert.ok(!after.json.actions.includes('NEW_VERSION'), 'идущий раунд блокирует изменение версии');
  const inherited = (await call(base + '/campaigns', { as: successor, query: { network: old.network_id, owner: next } })).json.items;
  assert.deepEqual(inherited.map((c: { id: string }) => c.id).sort(), portfolio.map((c: { id: string }) => c.id).sort());
  assert.ok(inherited.every((c: { owner_id: string }) => c.owner_id === next));
  assert.deepEqual((await call(base + '/campaigns/' + archived.id, { as: successor })).json.actions, []);
  assert.equal((await call(base + '/campaigns/' + archived.id + '/activities', { as: successor })).json.can_edit, false);
  const stats = (await call(base + '/analytics', { as: successor, query: { year: '2027', network: old.network_id } })).json;
  assert.deepEqual(stats.by_owner.map((o: { owner_id: string }) => o.owner_id), [next]);
  assert.deepEqual((await call(base + '/campaigns', { as: previous, query: { network: old.network_id } })).json.items, []);

  // Решение остаётся за уже назначенным согласующим. Новый ответственный получает результат.
  const beforeNotices = (await env.db.query('select count(*)::int n from kam.notification where campaign_id=$1 and user_id=$2', [created.json.id, old.user_id])).rows[0].n;
  const rejected = await call(url + '/approval/decision', { as: 'sergey.volkov', ifMatch: after.etag,
    body: { decision: 'REJECT', comment: 'Уточнить условия встречи' } });
  assert.equal(rejected.status, 200, rejected.body);
  assert.equal((await env.db.query('select count(*)::int n from kam.notification where campaign_id=$1 and user_id=$2', [created.json.id, old.user_id])).rows[0].n, beforeNotices);
  assert.equal((await env.db.query("select count(*)::int n from kam.notification where campaign_id=$1 and user_id=$2 and kind='RETURNED'", [created.json.id, next])).rows[0].n, 1);
  const card = await call(url, { as: successor });
  assert.ok(card.json.actions.includes('UPLOAD') && card.json.actions.includes('NEW_VERSION'));
  const contacts = (await call(base + '/networks/' + old.network_id + '/contacts', { as: successor })).json;
  assert.ok(contacts.can_edit && contacts.items.length);
  const meeting = { kind: 'MEETING', at: '2027-01-10T09:00:00Z', contact_id: contacts.items[0].id, purpose: 'Обсудить вторую версию' };
  assert.equal((await call(url + '/activities', { as: previous, body: meeting })).status, 404);
  assert.equal((await call(url + '/activities', { as: successor, body: meeting })).status, 201);
  const file = multipart({ kind: 'OUR_OFFER' }, { name: 'offer.txt', content: Buffer.from('second version') });
  const upload = (as: string) => env.app.inject({ method: 'POST', url: url + '/documents',
    headers: { ...file.headers, authorization: 'Bearer ' + env.tokens[as] }, payload: file.payload });
  assert.equal((await upload(previous)).statusCode, 404);
  const doc = await upload(successor);
  assert.equal(doc.statusCode, 201, doc.body);
  assert.equal((await call(url + '/versions', { as: previous, ifMatch: card.etag, body: offer })).status, 404);
  const second = await call(url + '/versions', { as: successor, ifMatch: card.etag,
    body: { ...offer, document_ids: [doc.json().id], comment: 'По итогам встречи' } });
  assert.equal(second.status, 201, second.body);
  assert.deepEqual((await call(url + '/versions', { as: successor })).json.items.map((v: { author: string }) => v.author), ['Анна Смирнова', 'Татьяна Лебедева']);
  const mismatch = await call(url, { method: 'PATCH', as: successor, ifMatch: second.etag, body: { owner_id: old.user_id } });
  assert.equal(mismatch.json.error.code, 'OWNER_FROM_NETWORK');
  const byManager = await call(base + '/campaigns', { as: 'elena.sokolova', body: fields });
  assert.equal(byManager.status, 201, byManager.body);
  assert.equal((await call(base + '/campaigns/' + byManager.json.id, { as: successor })).json.owner.id, next);
});

test('передача с будущей даты сохраняет сегодняшнего КАМа и использует общую границу периодов', async () => {
  const base = C(env);
  const old = await holder('Вита');
  const next = await userId(successor);
  const day = (await env.db.query('select (current_date+7)::text as handover_date')).rows[0].handover_date;
  const end = await call(base + '/assignments/' + old.id + '/end', { as: 'admin', body: { from: day } });
  assert.equal(end.status, 200, end.body);
  const add = await call(base + '/users/' + next + '/assignments', { as: 'admin', body: { network_id: old.network_id, from: day } });
  assert.equal(add.status, 201, add.body);
  const on = (await env.db.query(
    `select d::date, a.user_id from (values ($3::date-1), ($3::date)) as days(d) left join kam.kam_assignment a
       on a.client_id=$1 and a.network_id=$2 and a.valid @> d order by d`, [env.demo, old.network_id, day])).rows;
  assert.deepEqual(on.map((r) => r.user_id), [old.user_id, next]);
  const before = (await call(base + '/campaigns', { as: previous, query: { network: old.network_id } })).json.items;
  assert.ok(before.length && before.every((c: { owner_id: string }) => c.owner_id === old.user_id));
  assert.equal((await call(base + '/campaigns/' + before[0].id, { as: successor })).status, 404);
});

test('запись встречи из открытой карточки ждёт одновременную передачу сети и проверяет новое закрепление', async () => {
  const base = C(env);
  const old = await holder('Имплозия');
  const list = await call(base + '/campaigns', { as: previous, query: { network: old.network_id, stage: 'ACTIVE' } });
  const url = base + '/campaigns/' + list.json.items[0].id + '/activities';
  const tx = await env.db.connect();
  try {
    await tx.query('begin');
    const locker = (await tx.query('select pg_backend_pid() as pid')).rows[0].pid;
    await tx.query('select id from kam.network where client_id=$1 and id=$2 for update', [env.demo, old.network_id]);
    await tx.query("update kam.kam_assignment set valid=daterange(lower(valid),current_date,'[)') where client_id=$1 and id=$2", [env.demo, old.id]);
    const pending = call(url, { as: previous, body: { kind: 'MEETING', at: '2027-01-11T09:00:00Z', purpose: 'Встреча перед передачей' } });
    const deadline = Date.now() + 4000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = (await env.db.query('select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting', [locker])).rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await tx.query('commit');
    assert.equal((await pending).status, 404);
    assert.ok(waiting, 'команда дождалась блокировки сети');
  } finally {
    await tx.query('rollback');
    tx.release();
  }
});

test('если согласующий принял сеть, его шаг нельзя подписать ни лично, ни по замещению', async () => {
  const base = C(env);
  const manager = 'sergey.volkov';
  const deputy = 'olga.morozova';
  const managerId = await userId(manager);
  const { rows: [step] } = await env.db.query<{ campaign_id: string; network_id: string; assignment: string; date: string }>(
    `select s.campaign_id,c.network_id,a.id as assignment,current_date as date
       from kam.approval_step s join kam.campaign c on c.client_id=s.client_id and c.id=s.campaign_id
       join kam.kam_assignment a on a.client_id=c.client_id and a.network_id=c.network_id and a.valid @> current_date
      where s.client_id=$1 and s.status='ACTIVE' and s.candidates = array[$2::uuid] and a.user_id <> $2 limit 1`, [env.demo, managerId]);
  assert.ok(step);
  const url = base + '/campaigns/' + step.campaign_id;
  assert.equal((await call(base + '/substitutions', { as: manager,
    body: { deputy_id: await userId(deputy), from: step.date, to: step.date } })).status, 201);
  assert.ok((await call(url + '/approval', { as: deputy })).json.my_decision);
  assert.equal((await call(base + '/assignments/' + step.assignment + '/end', { as: 'admin', body: {} })).status, 200);
  assert.equal((await call(base + '/users/' + managerId + '/assignments', { as: 'admin', body: { network_id: step.network_id } })).status, 201);
  for (const as of [manager, deputy]) {
    const inbox = (await call(base + '/my-decisions', { as })).json.items;
    assert.ok(inbox.every((s: { campaign_id: string }) => s.campaign_id !== step.campaign_id));
    assert.equal((await call(url + '/approval', { as })).json.my_decision, null);
    const card = await call(url, { as });
    assert.equal((await call(url + '/approval/decision', { as, ifMatch: card.etag, body: { decision: 'APPROVE' } })).status, 403);
  }
});
