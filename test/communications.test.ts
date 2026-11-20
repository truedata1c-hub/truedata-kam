import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, api, C, multipart, type TestEnv } from './helpers.js';
import { processOutbox, runSchedule, setSender } from '../src/notify.js';
import { housekeeping } from '../src/housekeeping.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const one = async <T>(sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows[0] as T;
const id = async (table: string, name: string, col = 'name') => (await one<{ id: string }>(`select id from kam.${table} where ${col}=$1`, [name])).id;
const userId = (login: string) => id('app_user', `${login}@demo.test`, 'email');
const etag = async (cid: string, as: string) => (await call(`${C(env)}/campaigns/${cid}`, { as })).etag!;

async function negotiation(as: string, network: string, investment = 300_000, type = 'Ассортиментное соглашение') {
  const r = await call(`${C(env)}/campaigns`, { as, body: { network_id: await id('network', network), type_id: await id('campaign_type', type), title: `Тест ${Math.random()}`, period_from: '2027-01-01', period_to: '2027-06-30' } });
  const cid = r.json.id as string;
  await call(`${C(env)}/campaigns/${cid}/transitions`, { as, ifMatch: await etag(cid, as), body: { action: 'START_NEGOTIATION' } });
  const draft = (await call(`${C(env)}/campaigns/${cid}/versions/draft`, { as })).json;
  const brand = await id('brand', 'Кардиовел');
  const cells = draft.periods.map((p: { key: string }) => ({ brand_id: brand, period_key: p.key, investment: investment / draft.periods.length, turnover: investment * 3 }));
  assert.equal((await call(`${C(env)}/campaigns/${cid}/versions`, { as, ifMatch: await etag(cid, as), body: { cells, justification: 'Рост' } })).status, 201);
  return cid;
}
const submit = async (as: string, cid: string) => call(`${C(env)}/campaigns/${cid}/approval/submit`, { as, ifMatch: await etag(cid, as), body: {} });
const decide = async (as: string, cid: string, decision: string, comment?: string) => call(`${C(env)}/campaigns/${cid}/approval/decision`, { as, ifMatch: await etag(cid, as), body: { decision, comment } });
const move = async (as: string, cid: string, action: string, extra: Record<string, unknown> = {}) => call(`${C(env)}/campaigns/${cid}/transitions`, { as, ifMatch: await etag(cid, as), body: { action, ...extra } });
const upload = async (as: string, cid: string, kind: string, name = 'файл.xlsx') => {
  const token = env.tokens[as] ?? (await env.login(as));
  const mp = multipart({ kind }, { name, content: Buffer.from('PK test ' + Math.random()) });
  const res = await env.app.inject({ method: 'POST', url: `${C(env)}/campaigns/${cid}/documents`, headers: { ...mp.headers, authorization: `Bearer ${token}` }, payload: mp.payload });
  return res.json().id as string;
};
const notes = async (as: string, campaign?: string) => (await call(`${C(env)}/notifications`, { as })).json.items.filter((n: any) => !campaign || n.campaign_id === campaign);

test('уведомления по маршруту: новый шаг, возврат, согласование; письма ждут подключения почты', async () => {
  const cid = await negotiation('anna.smirnova', 'Ригла');
  assert.equal((await submit('anna.smirnova', cid)).status, 201);
  const step = (await notes('elena.sokolova', cid)).find((n: any) => n.kind === 'STEP_ASSIGNED');
  assert.ok(step);
  assert.match(step.title, /Нужно ваше решение: Ригла/);
  assert.equal(step.actor_name, 'Анна Смирнова');
  const mail = await one<{ status: string; to_email: string }>('select status, to_email from kam.email_outbox where user_id=$1 order by created_at desc limit 1', [await userId('elena.sokolova')]);
  assert.deepEqual(mail, { status: 'NO_CHANNEL', to_email: 'elena.sokolova@demo.test' });
  // Автор действия себе уведомлений не получает.
  assert.equal((await notes('anna.smirnova', cid)).length, 0);

  // Анна отключает письма о возврате.
  const prefs = (await call(`${C(env)}/notification-prefs`, { as: 'anna.smirnova' })).json;
  assert.equal(prefs.channel_configured, false);
  assert.equal(prefs.items.find((p: any) => p.kind === 'RETURNED').email, true);
  assert.equal((await call(`${C(env)}/notification-prefs`, { method: 'PUT', as: 'anna.smirnova', body: { email: { RETURNED: false } } })).status, 200);
  const before = await one<{ n: number }>('select count(*)::int n from kam.email_outbox where user_id=$1', [await userId('anna.smirnova')]);
  assert.equal((await decide('elena.sokolova', cid, 'REJECT', 'Снизьте ставку')).status, 200);
  const ret = (await notes('anna.smirnova', cid)).find((n: any) => n.kind === 'RETURNED');
  assert.match(ret.body, /Снизьте ставку/);
  const afterCount = await one<{ n: number }>('select count(*)::int n from kam.email_outbox where user_id=$1', [await userId('anna.smirnova')]);
  assert.equal(afterCount.n, before.n);

  const list = await call(`${C(env)}/notifications`, { as: 'anna.smirnova' });
  assert.ok(list.json.unread >= 1);
  assert.equal((await call(`${C(env)}/notifications/read`, { as: 'anna.smirnova', body: { all: true } })).status, 200);
  assert.equal((await call(`${C(env)}/notifications`, { as: 'anna.smirnova' })).json.unread, 0);
});

test('сценарий 15: почтовый канал — очередь до подключения, отправка после, повтор при ошибке', async () => {
  // Пароль SMTP хранится зашифрованным ключом стенда.
  process.env.SETTINGS_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
  const queued = await one<{ n: number }>("select count(*)::int n from kam.email_outbox where client_id=$1 and status='NO_CHANNEL'", [env.demo]);
  assert.ok(queued.n > 0);
  // Свежие письма (до 3 суток) уйдут, давние — устарели: подключение почты не рассылает старые напоминания задним числом.
  await env.db.query("update kam.email_outbox set created_at = now() - interval '10 days' where id = (select id from kam.email_outbox where client_id=$1 and status='NO_CHANNEL' order by created_at limit 1)", [env.demo]);
  const fresh = await one<{ n: number }>("select count(*)::int n from kam.email_outbox where client_id=$1 and status='NO_CHANNEL' and created_at > now() - interval '72 hours'", [env.demo]);
  assert.ok(fresh.n > 0);
  assert.equal((await call(`${C(env)}/mail`, { as: 'anna.smirnova' })).status, 403);
  const bad = await call(`${C(env)}/mail`, { method: 'PUT', as: 'admin', body: { host: 'smtp.example.ru', port: 587, from: 'не адрес' } });
  assert.equal(bad.json.error.field, 'from');
  const save = await call(`${C(env)}/mail`, { method: 'PUT', as: 'admin', body: { host: 'smtp.example.ru', port: 587, user: 'kam', password: 'secret-pass', from: 'kam@example.ru' } });
  assert.equal(save.status, 200, save.body);
  assert.equal(save.json.released, fresh.n);
  assert.equal(save.json.released + save.json.expired, queued.n);
  assert.ok(save.json.expired >= 1);
  const view = (await call(`${C(env)}/mail`, { as: 'admin' })).json;
  assert.equal(view.smtp.has_password, true);
  assert.equal(JSON.stringify(view).includes('secret-pass'), false);
  const stored = await one<{ p: string }>("select settings->'smtp'->>'password' p from kam.client_setting where client_id=$1", [env.demo]);
  assert.match(stored.p, /^enc:v1:/);

  // Первая попытка: сервер недоступен — письма уходят на повтор.
  setSender(async () => { throw new Error('connect ECONNREFUSED'); });
  const fail = await processOutbox(env.db, 500);
  assert.ok(fail.failed > 0);
  const retry = await one<{ status: string; attempts: number; last_error: string }>("select status, attempts, last_error from kam.email_outbox where client_id=$1 and status <> 'EXPIRED' order by created_at limit 1", [env.demo]);
  assert.deepEqual([retry.status, retry.attempts], ['RETRY', 1]);
  assert.match(retry.last_error, /ECONNREFUSED/);
  // Повтор созрел — сервер ответил.
  await env.db.query("update kam.email_outbox set next_attempt_at = now() - interval '1 minute' where client_id=$1 and status='RETRY'", [env.demo]);
  const sent: string[] = [];
  setSender(async (smtp, m) => { assert.equal(smtp.password, 'secret-pass'); sent.push(m.to); });
  const ok = await processOutbox(env.db, 500);
  assert.equal(ok.sent, fail.failed);
  assert.ok(sent.every((x) => x.endsWith('@demo.test')));
  // Проверочное письмо администратору.
  assert.equal((await call(`${C(env)}/mail/test`, { as: 'admin', body: {} })).json.queued, true);
  assert.equal((await processOutbox(env.db)).sent, 1);
  // Отключение канала: новые письма снова копятся.
  // Устаревшее письмо можно отправить вручную.
  const expired = await one<{ id: string }>("select id from kam.email_outbox where client_id=$1 and status='EXPIRED' limit 1", [env.demo]);
  assert.equal((await call(`${C(env)}/mail/${expired.id}/retry`, { as: 'admin', body: {} })).json.updated, 1);
  assert.equal((await processOutbox(env.db)).sent, 1);
  // Отключение канала: новые письма снова копятся.
  assert.equal((await call(`${C(env)}/mail`, { method: 'PUT', as: 'admin', body: { disabled: true } })).status, 200);
  assert.equal((await call(`${C(env)}/mail/test`, { as: 'admin', body: {} })).json.queued, false);
  } finally {
    delete process.env.SETTINGS_KEY;
  }
});

test('подтверждение сетью и финальные условия требуют документа нужного типа; согласовавшие получают уведомление', async () => {
  const cid = await negotiation('dmitry.petrov', 'Неофарм');
  await submit('dmitry.petrov', cid);
  assert.equal((await decide('elena.sokolova', cid, 'APPROVE')).json.stage, 'APPROVED');
  const card = (await call(`${C(env)}/campaigns/${cid}`, { as: 'dmitry.petrov' })).json;
  assert.ok(card.actions.includes('CONFIRM'));
  assert.equal((await move('dmitry.petrov', cid, 'CONFIRM')).json.error.code, 'CONFIRMATION_DOCUMENT_REQUIRED');
  const other = await upload('dmitry.petrov', cid, 'OTHER');
  assert.equal((await move('dmitry.petrov', cid, 'CONFIRM', { document_id: other })).json.error.code, 'CONFIRMATION_DOCUMENT_REQUIRED');
  const conf = await upload('dmitry.petrov', cid, 'NETWORK_CONFIRMATION', 'Письмо сети.pdf');
  const r = await move('dmitry.petrov', cid, 'CONFIRM', { document_id: conf });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.stage, 'CONFIRMED');
  const after = (await call(`${C(env)}/campaigns/${cid}`, { as: 'dmitry.petrov' })).json;
  assert.equal(after.confirmation.file_name, 'Письмо сети.pdf');
  assert.ok((await notes('elena.sokolova', cid)).some((n: any) => n.kind === 'CONFIRMED'));
  assert.equal((await move('dmitry.petrov', cid, 'FINALIZE', { document_id: conf })).json.error.code, 'FINAL_DOCUMENT_REQUIRED');
  const fin = await upload('dmitry.petrov', cid, 'FINAL_TERMS', 'Финальные условия.xlsx');
  assert.equal((await move('dmitry.petrov', cid, 'FINALIZE', { document_id: fin })).json.stage, 'FINAL');
  assert.equal((await move('dmitry.petrov', cid, 'CLOSE')).json.stage, 'CLOSED');
  const done = (await call(`${C(env)}/campaigns/${cid}`, { as: 'dmitry.petrov' })).json;
  assert.equal(done.final_terms.file_name, 'Финальные условия.xlsx');
  // Вместе с документами зафиксирована версия разбивки — источник для выгрузки в PharmaCheck.
  assert.equal(done.confirmation.version, 1);
  assert.equal(done.final_terms.version, 1);
  const snap = await call(`${C(env)}/campaigns/${cid}/final-snapshot`, { as: 'dmitry.petrov' });
  assert.equal(snap.status, 200, snap.body);
  assert.equal(snap.json.network.name, 'Неофарм');
  assert.ok(snap.json.legal_entities.length > 0 && snap.json.legal_entities.every((e: any) => /^\d{10}(\d{2})?$/.test(e.inn)));
  assert.equal(snap.json.version.number, 1);
  assert.equal(snap.json.version.total_investment, 300000);
  assert.equal(snap.json.version.cells.reduce((a: number, x: any) => a + x.investment, 0), 300000);
  assert.equal(snap.json.final_document.file_name, 'Финальные условия.xlsx');
  assert.equal(snap.json.vat, 'NOT_SPECIFIED');
  // До финала снимка нет.
  const early = await negotiation('dmitry.petrov', 'Будь Здоров');
  assert.equal((await call(`${C(env)}/campaigns/${early}/final-snapshot`, { as: 'dmitry.petrov' })).json.error.code, 'NOT_FINAL');
});

test('переписка: упоминание участника с уведомлением; не участника упомянуть нельзя; согласующий пишет в кампанию', async () => {
  const cid = await negotiation('anna.smirnova', 'АСНА');
  await submit('anna.smirnova', cid);
  const list = (await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'anna.smirnova' })).json;
  const names = list.participants.map((p: any) => p.name);
  assert.ok(names.includes('Елена Соколова'));
  assert.ok(!names.includes('Илья Иванов'));
  const elena = await userId('elena.sokolova');
  assert.equal((await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'anna.smirnova', body: { body: '  ' } })).status, 422);
  assert.equal((await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'anna.smirnova', body: { body: '@Илья посмотри', mention_ids: [await userId('ilya.ivanov')] } })).json.error.field, 'mention_ids');
  assert.equal((await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'anna.smirnova', body: { body: '@Елена Соколова посмотрите расчёт', mention_ids: [elena] } })).status, 201);
  assert.ok((await notes('elena.sokolova', cid)).some((n: any) => n.kind === 'MENTION' && n.body.includes('посмотрите расчёт')));
  assert.equal((await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'elena.sokolova', body: { body: 'Смотрю' } })).status, 201);
  const feed = (await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'anna.smirnova' })).json.items;
  assert.deepEqual(feed.map((c: any) => [c.author_name, c.mine]), [['Анна Смирнова', true], ['Елена Соколова', false]]);
  assert.deepEqual(feed[0].mentioned.map((m: any) => m.name), ['Елена Соколова']);
  assert.equal((await call(`${C(env)}/campaigns/${cid}/comments`, { as: 'ilya.ivanov', body: { body: 'чужое' } })).status, 404);
});

test('контакты сети и активности кампании: проверки, завершённая активность в истории', async () => {
  const rigla = await id('network', 'Ригла');
  const contacts = (await call(`${C(env)}/networks/${rigla}/contacts`, { as: 'anna.smirnova' })).json;
  assert.equal(contacts.can_edit, true);
  assert.ok(contacts.items.length >= 2);
  const c = await call(`${C(env)}/networks/${rigla}/contacts`, { as: 'anna.smirnova', body: { name: 'Пётр Новый', position: 'Байер', email: 'petr@rigla.test', is_key: true } });
  assert.equal(c.status, 201);
  assert.equal((await call(`${C(env)}/networks/${rigla}/contacts`, { as: 'ilya.ivanov' })).status, 404);
  assert.equal((await call(`${C(env)}/networks/${rigla}/contacts`, { as: 'anna.smirnova', body: { name: 'X', email: 'плохо' } })).json.error.field, 'email');

  const cid = await negotiation('anna.smirnova', 'Ригла');
  const base = `${C(env)}/campaigns/${cid}/activities`;
  assert.equal((await call(base, { as: 'anna.smirnova', body: { kind: 'MEETING', at: '2026-11-25T10:00:00+03:00', status: 'PLANNED' } })).json.error.field, 'purpose');
  const neofarmContact = (await call(`${C(env)}/networks/${await id('network', 'Неофарм')}/contacts`, { as: 'dmitry.petrov' })).json.items[0].id;
  assert.equal((await call(base, { as: 'anna.smirnova', body: { kind: 'CALL', at: '2026-11-25T10:00:00+03:00', purpose: 'X', contact_id: neofarmContact } })).json.error.field, 'contact_id');
  const a = await call(base, { as: 'anna.smirnova', body: { kind: 'MEETING', at: '2026-11-25T10:00:00+03:00', purpose: 'Обсудить ставку', contact_id: c.json.id } });
  assert.equal(a.status, 201, a.body);
  assert.equal((await call(`${base}/${a.json.id}`, { method: 'PUT', as: 'anna.smirnova', body: { kind: 'MEETING', at: '2026-11-25T10:00:00+03:00', purpose: 'Обсудить ставку', status: 'DONE' } })).json.error.field, 'outcome');
  assert.equal((await call(`${base}/${a.json.id}`, { method: 'PUT', as: 'anna.smirnova', body: { kind: 'MEETING', at: '2026-11-25T10:00:00+03:00', purpose: 'Обсудить ставку', status: 'DONE', outcome: 'Сеть согласна на 5 %' } })).status, 200);
  const items = (await call(base, { as: 'anna.smirnova' })).json.items;
  assert.equal(items[0].status, 'DONE');
  assert.equal(items[0].done_by_name, 'Анна Смирнова');
  const ev = (await call(`${C(env)}/campaigns/${cid}`, { as: 'anna.smirnova' })).json.events.find((e: any) => e.kind === 'ACTIVITY_DONE');
  assert.equal(ev.comment, 'Сеть согласна на 5 %');
  assert.equal((await call(base, { as: 'olga.morozova', body: { kind: 'CALL', at: '2026-11-25T10:00:00+03:00', purpose: 'X' } })).status, 201); // руководитель ведёт за подчинённых
  assert.equal((await call(base, { as: 'igor.vasiliev', body: { kind: 'CALL', at: '2026-11-25T10:00:00+03:00', purpose: 'X' } })).status, 403);
});

test('планировщик: просрочка шага — исполнителю и его руководителю, напоминание в день срока, контрольная дата — один раз', async () => {
  const cid = await negotiation('maria.kuznetsova', 'Озерки');
  await submit('maria.kuznetsova', cid);
  await env.db.query("update kam.approval_step set due_date = current_date - 1 where campaign_id=$1 and status='ACTIVE'", [cid]);
  await env.db.query('update kam.campaign set control_date = current_date - 1 where id=$1', [cid]);
  const r1 = await runSchedule(env.db);
  assert.ok(r1.overdue >= 1 && r1.control >= 1);
  assert.ok((await notes('elena.sokolova', cid)).some((n: any) => n.kind === 'STEP_OVERDUE'));
  assert.ok((await notes('olga.morozova', cid)).some((n: any) => n.kind === 'STEP_OVERDUE'));
  assert.ok((await notes('maria.kuznetsova', cid)).some((n: any) => n.kind === 'CONTROL_OVERDUE'));
  const r2 = await runSchedule(env.db);
  assert.deepEqual(r2, { reminders: 0, overdue: 0, control: 0 });

  const other = await negotiation('maria.kuznetsova', 'Горздрав');
  await submit('maria.kuznetsova', other);
  await env.db.query("update kam.approval_step set due_date = current_date where campaign_id=$1 and status='ACTIVE'", [other]);
  assert.equal((await runSchedule(env.db)).reminders, 1);
  assert.ok((await notes('elena.sokolova', other)).some((n: any) => n.kind === 'STEP_REMINDER'));
});

test('перенос контрольной даты снова включает уведомление о её просрочке', async () => {
  const cid = await negotiation('maria.kuznetsova', 'Эркафарм');
  await env.db.query('update kam.campaign set control_date = current_date - 1 where id=$1', [cid]);
  await runSchedule(env.db);
  const notified = await one<{ at: string | null }>('select control_overdue_notified_at at from kam.campaign where id=$1', [cid]);
  assert.ok(notified.at);
  // Новая дата тоже прошла: КАМ снова получает уведомление.
  const day = (await one<{ d: string }>("select (current_date - 2)::text d")).d;
  const upd = await call(`${C(env)}/campaigns/${cid}`, { method: 'PATCH', as: 'maria.kuznetsova', ifMatch: await etag(cid, 'maria.kuznetsova'), body: { control_date: day } });
  assert.equal(upd.status, 200, upd.body);
  assert.equal((await one<{ at: string | null }>('select control_overdue_notified_at at from kam.campaign where id=$1', [cid])).at, null);
  assert.ok((await runSchedule(env.db)).control >= 1);
  // Правка без переноса даты отметку не сбрасывает.
  await call(`${C(env)}/campaigns/${cid}`, { method: 'PATCH', as: 'maria.kuznetsova', ifMatch: await etag(cid, 'maria.kuznetsova'), body: { title: 'Новое название' } });
  assert.ok((await one<{ at: string | null }>('select control_overdue_notified_at at from kam.campaign where id=$1', [cid])).at);
});

test('очистка служебных таблиц: старое удаляется, свежее и журнал остаются', async () => {
  const anna = await userId('anna.smirnova');
  await env.db.query("insert into kam.session(token_hash, user_id, expires_at) values ('old-session', $1, now() - interval '3 days'), ('live-session', $1, now() + interval '1 hour')", [anna]);
  await env.db.query("update kam.idempotency_request set created_at = now() - interval '40 days' where key = (select key from kam.idempotency_request limit 1)");
  const oldNote = await one<{ id: string }>("update kam.notification set created_at = now() - interval '200 days', read_at = now() - interval '199 days' where id = (select id from kam.notification limit 1) returning id");
  const freshNote = await one<{ id: string }>("select id from kam.notification where id <> $1 order by created_at desc limit 1", [oldNote.id]);
  await env.db.query("update kam.email_outbox set status='SENT', created_at = now() - interval '200 days' where id = (select id from kam.email_outbox limit 1)");
  const audit = await one<{ n: number }>('select count(*)::int n from kam.audit_event');
  const r = await housekeeping(env.db);
  assert.ok(r.sessions >= 1 && r.idempotency >= 1 && r.notifications >= 1 && r.emails >= 1, JSON.stringify(r));
  assert.equal((await env.db.query("select 1 from kam.session where token_hash='old-session'")).rowCount, 0);
  assert.equal((await env.db.query("select 1 from kam.session where token_hash='live-session'")).rowCount, 1);
  assert.equal((await env.db.query('select 1 from kam.notification where id=$1', [oldNote.id])).rowCount, 0);
  assert.equal((await env.db.query('select 1 from kam.notification where id=$1', [freshNote.id])).rowCount, 1);
  assert.equal((await one<{ n: number }>('select count(*)::int n from kam.audit_event')).n, audit.n);
  // Повторный запуск ничего не находит.
  const again = await housekeeping(env.db);
  assert.equal(again.sessions + again.idempotency + again.notifications + again.emails, 0);
});
