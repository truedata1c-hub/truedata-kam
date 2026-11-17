import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, api, C, multipart, type TestEnv } from './helpers.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function campaignOf(login: string, stage = 'NEGOTIATION') {
  const r = await env.db.query<{ id: string }>(
    `select c.id from kam.campaign c join kam.app_user u on u.id = c.owner_id where u.email=$1 and c.stage=$2 order by c.number limit 1`, [`${login}@demo.test`, stage]);
  return r.rows[0]!.id;
}
const upload = async (as: string, campaign: string, file: { name: string; content: Buffer }, fields: Record<string, string> = { kind: 'NETWORK_OFFER' }) => {
  const token = env.tokens[as] ?? (await env.login(as));
  const mp = multipart(fields, file);
  const res = await env.app.inject({ method: 'POST', url: `${C(env)}/campaigns/${campaign}/documents`, headers: { ...mp.headers, authorization: `Bearer ${token}` }, payload: mp.payload });
  return { status: res.statusCode, json: res.json() };
};

test('загрузка, список, просмотр PDF и скачивание; повтор того же файла не создаёт дубль', async () => {
  const id = await campaignOf('anna.smirnova');
  const up = await upload('anna.smirnova', id, { name: 'Предложение сети.pdf', content: PDF }, { kind: 'NETWORK_OFFER', comment: 'Ответ сети от 12.11' });
  assert.equal(up.status, 201);
  const again = await upload('anna.smirnova', id, { name: 'копия.pdf', content: PDF });
  assert.deepEqual(again.json, { id: up.json.id, duplicate: true });
  const list = (await call(`${C(env)}/campaigns/${id}/documents`, { as: 'anna.smirnova' })).json.items;
  const doc = list.find((d: any) => d.id === up.json.id);
  assert.equal(doc.file_name, 'Предложение сети.pdf');
  assert.equal(doc.previewable, true);
  assert.equal(doc.comment, 'Ответ сети от 12.11');
  const auth = { authorization: `Bearer ${env.tokens['anna.smirnova']}` };
  const view = await env.app.inject({ method: 'GET', url: `${C(env)}/campaigns/${id}/documents/${up.json.id}/file?inline=1`, headers: auth });
  assert.equal(view.headers['content-type'], 'application/pdf');
  assert.match(String(view.headers['content-disposition']), /^inline;/);
  assert.match(String(view.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(view.rawPayload.toString(), PDF.toString());
  const dl = await env.app.inject({ method: 'GET', url: `${C(env)}/campaigns/${id}/documents/${up.json.id}/file`, headers: auth });
  assert.equal(dl.headers['content-type'], 'application/octet-stream');
  assert.match(String(dl.headers['content-disposition']), /^attachment;.*filename\*=UTF-8''%D0%9F/);
  const events = (await call(`${C(env)}/campaigns/${id}`, { as: 'anna.smirnova' })).json.events;
  assert.equal(events[0].kind, 'DOCUMENT_UPLOADED');
});

test('Excel не открывается в браузере, а скачивается; исполняемые файлы не принимаются', async () => {
  const id = await campaignOf('anna.smirnova');
  const xl = await upload('anna.smirnova', id, { name: 'расчёт.xlsx', content: Buffer.from('PK\u0003\u0004 fake xlsx') }, { kind: 'CALCULATION' });
  const auth = { authorization: `Bearer ${env.tokens['anna.smirnova']}` };
  const res = await env.app.inject({ method: 'GET', url: `${C(env)}/campaigns/${id}/documents/${xl.json.id}/file?inline=1`, headers: auth });
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  assert.equal((await upload('anna.smirnova', id, { name: 'setup.exe', content: Buffer.from('MZ....') })).json.error.code, 'FILE_TYPE_BLOCKED');
  assert.equal((await upload('anna.smirnova', id, { name: 'отчёт.pdf', content: Buffer.from('MZ\u0090\u0000 disguised') })).json.error.code, 'FILE_TYPE_BLOCKED');
  assert.equal((await upload('anna.smirnova', id, { name: 'page.html', content: Buffer.from('<script>') })).json.error.code, 'FILE_TYPE_BLOCKED');
  assert.equal((await upload('anna.smirnova', id, { name: 'x.pdf', content: PDF }, { kind: 'WHATEVER' })).json.error.field, 'kind');
});

test('архив с причиной; архивный документ нельзя приложить к версии; чужой КАМ — 404', async () => {
  const id = await campaignOf('dmitry.petrov');
  const up = await upload('dmitry.petrov', id, { name: 'протокол.pdf', content: Buffer.from('%PDF-1.4 protocol') }, { kind: 'MEETING_MINUTES' });
  const url = `${C(env)}/campaigns/${id}/documents/${up.json.id}`;
  assert.equal((await call(`${url}/archive`, { as: 'dmitry.petrov', body: {} })).json.error.field, 'reason');
  assert.equal((await call(`${url}/archive`, { as: 'dmitry.petrov', body: { reason: 'Загружен по ошибке' } })).status, 200);
  const card = await call(`${C(env)}/campaigns/${id}`, { as: 'dmitry.petrov' });
  const brand = (await env.db.query<{ id: string }>("select id from kam.brand where name='Кардиовел'")).rows[0]!.id;
  const draft = (await call(`${C(env)}/campaigns/${id}/versions/draft`, { as: 'dmitry.petrov' })).json;
  const v = await call(`${C(env)}/campaigns/${id}/versions`, { as: 'dmitry.petrov', ifMatch: card.etag,
    body: { cells: [{ brand_id: brand, period_key: draft.periods[0].key, investment: 1, turnover: 2 }], document_ids: [up.json.id] } });
  assert.equal(v.json.error.field, 'document_ids');
  assert.equal((await env.app.inject({ method: 'GET', url: `${url}/file`, headers: { authorization: `Bearer ${await env.login('ilya.ivanov')}` } })).statusCode, 404);
  assert.equal((await upload('ilya.ivanov', id, { name: 'x.pdf', content: PDF })).status, 404);
});

test('в отменённую кампанию документы не загружаются', async () => {
  const id = (await env.db.query<{ id: string; email: string }>(
    "select c.id, u.email from kam.campaign c join kam.app_user u on u.id = c.owner_id where c.stage='CANCELLED' limit 1")).rows[0]!;
  const login = (await env.db.query<{ email: string }>("select u.email from kam.campaign c join kam.app_user u on u.id = c.owner_id where c.id=$1", [id.id])).rows[0]!.email.split('@')[0]!;
  assert.equal((await upload(login, id.id, { name: 'x.pdf', content: PDF })).json.error.code, 'STAGE_LOCKED');
});

test('у демо-кампаний есть версии с файлами предложения', async () => {
  const r = (await env.db.query<{ v: number; d: number }>('select count(*)::int v, (select count(*)::int from kam.document) d from kam.offer_version')).rows[0]!;
  assert.ok(r.v > 60 && r.d >= r.v);
});
