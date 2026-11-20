import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, api, C, type TestEnv } from './helpers.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const get = async (as: string, query: Record<string, string> = {}) => call(`${C(env)}/analytics`, { as, query: { year: '2027', ...query } });
const near = (a: number, b: number) => Math.abs(a - b) < 1;

test('аналитика: суммы сходятся между разрезами, воронка — с портфелем', async () => {
  const r = await get('olga.morozova');
  assert.equal(r.status, 200, r.body);
  const d = r.json;
  const brands = d.by_brand.reduce((a: number, b: any) => a + b.investment, 0);
  const quarters = d.by_quarter.reduce((a: number, q: any) => a + q.investment, 0);
  const nets = d.by_network.reduce((a: number, n: any) => a + n.investment, 0);
  assert.ok(d.kpi.investment > 0);
  // Единая методика: все разрезы — доля версий, приходящаяся на 2027 год, поэтому суммы совпадают между разрезами.
  assert.ok(near(nets, d.kpi.investment), `${nets} vs ${d.kpi.investment}`);
  assert.ok(near(brands, quarters), `${brands} vs ${quarters}`);
  assert.ok(near(brands, d.kpi.investment), `${brands} vs ${d.kpi.investment}`);
  const owners = d.by_owner.reduce((a: number, o: any) => a + o.investment, 0);
  assert.ok(near(owners, d.kpi.investment), `${owners} vs ${d.kpi.investment}`);
  const portfolio = (await call(`${C(env)}/campaigns`, { as: 'olga.morozova', query: { year: '2027', stage: 'ALL' } })).json;
  for (const f of d.funnel) assert.equal(f.count, portfolio.items.filter((c: any) => c.stage === f.stage).length, f.stage);
  assert.ok(d.timing.find((t: any) => t.stage === 'NEGOTIATION').avg_days > 0);
  assert.ok(d.steps.some((s: any) => s.title === 'Руководитель КАМ' && s.decided > 0));
  assert.ok(d.by_brand.every((b: any) => b.brand_id));
  assert.equal(d.brand_limited, false);
  assert.ok(d.pulse.length > 0);
});

test('сценарий 13: бренд-менеджер видит свои бренды подробно, остальные — строкой «Прочие бренды»', async () => {
  const d = (await get('ksenia.orlova')).json;
  assert.equal(d.brand_limited, true);
  const names = d.by_brand.map((b: any) => b.name).sort();
  assert.deepEqual(names, ['Венотон', 'Кардиовел', 'Прочие бренды']);
  const full = (await get('igor.vasiliev')).json; // финансовый директор: все сети, все бренды
  assert.ok(near(d.kpi.investment, full.kpi.investment));
  const kardio = full.by_brand.find((b: any) => b.name === 'Кардиовел');
  assert.ok(near(d.by_brand.find((b: any) => b.name === 'Кардиовел').investment, kardio.investment));
  const other = full.by_brand.filter((b: any) => !['Венотон', 'Кардиовел'].includes(b.name)).reduce((a: number, b: any) => a + b.investment, 0);
  assert.ok(near(d.by_brand.find((b: any) => b.name === 'Прочие бренды').investment, other));
});

test('аналитика в области видимости: КАМ — свои кампании, фильтры, без полномочия — 403, чужой клиент — 404', async () => {
  const anna = (await get('anna.smirnova')).json;
  assert.deepEqual(anna.by_owner.map((o: any) => o.name), ['Анна Смирнова']);
  const portfolio = (await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', query: { year: '2027', stage: 'ALL' } })).json;
  assert.equal(anna.kpi.campaigns, portfolio.items.length);
  const typeId = (await env.db.query("select id from kam.campaign_type where name='Годовые условия'")).rows[0].id;
  const annual = (await get('olga.morozova', { type: typeId })).json;
  const all = (await get('olga.morozova')).json;
  assert.ok(annual.kpi.campaigns < all.kpi.campaigns);
  assert.equal((await get('admin')).status, 403);
  assert.equal((await call(`${C(env, env.other)}/analytics`, { as: 'olga.morozova' })).status, 404);
});

test('портфель: фильтр по бренду — кампании с брендом в текущей версии', async () => {
  const brand = (await env.db.query("select id from kam.brand where name='Пульмодил'")).rows[0].id;
  const r = (await call(`${C(env)}/campaigns`, { as: 'olga.morozova', query: { year: '2027', stage: 'ALL', brand } })).json;
  const all = (await call(`${C(env)}/campaigns`, { as: 'olga.morozova', query: { year: '2027', stage: 'ALL' } })).json;
  assert.ok(r.items.length > 0 && r.items.length < all.items.length);
});

test('резервные копии: администратор видит последнюю копию, остальным — 403', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'kam-bk-'));
  await mkdir(path.join(dir, 'db'));
  await writeFile(path.join(dir, 'db', 'kam-20261118-031500.dump'), Buffer.alloc(2048));
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), file: 'kam-20261118-031500.dump', bytes: 2048, files: 7 }));
  process.env.BACKUP_DIR = dir;
  try {
    const r = await call(`${C(env)}/backups`, { as: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.last.ok, true);
    assert.equal(r.json.dumps[0].bytes, 2048);
    assert.equal(r.json.stale, false);
    assert.equal((await call(`${C(env)}/backups`, { as: 'olga.morozova' })).status, 403);
  } finally { delete process.env.BACKUP_DIR; }
});

test('аналитика: переходящая кампания учитывается долей года во всех разрезах', async () => {
  const one = async (sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows[0];
  const before27 = (await get('anna.smirnova')).json.kpi;
  const before28 = (await get('anna.smirnova', { year: '2028' })).json.kpi;
  const r = await call(`${C(env)}/campaigns`, { as: 'anna.smirnova', body: {
    network_id: (await one("select id from kam.network where name='Ригла'")).id, type_id: (await one("select id from kam.campaign_type where name='Разовая акция'")).id,
    title: 'Переходящая акция', period_from: '2027-12-01', period_to: '2028-01-31' } });
  assert.equal(r.status, 201, r.body);
  const card = await call(`${C(env)}/campaigns/${r.json.id}`, { as: 'anna.smirnova' });
  const moved = await call(`${C(env)}/campaigns/${r.json.id}/transitions`, { as: 'anna.smirnova', ifMatch: card.etag, body: { action: 'START_NEGOTIATION' } });
  const brand = (await one("select id from kam.brand where name='Кардиовел'")).id;
  const v = await call(`${C(env)}/campaigns/${r.json.id}/versions`, { as: 'anna.smirnova', ifMatch: moved.etag, body: { cells: [
    { brand_id: brand, period_key: '2027-M12', investment: 100000, turnover: 500000 },
    { brand_id: brand, period_key: '2028-M01', investment: 300000, turnover: 900000 },
  ] } });
  assert.equal(v.status, 201, v.body);
  const after27 = (await get('anna.smirnova')).json;
  const after28 = (await get('anna.smirnova', { year: '2028' })).json;
  assert.ok(near(after27.kpi.investment - before27.investment, 100000), `${after27.kpi.investment - before27.investment}`);
  assert.ok(near(after28.kpi.investment - before28.investment, 300000), `${after28.kpi.investment - before28.investment}`);
  // Сети, КАМ и воронка — та же доля года, что и бренды.
  const nets = after27.by_network.reduce((a: number, n: any) => a + n.investment, 0);
  assert.ok(near(nets, after27.kpi.investment));
  const negotiation = after27.funnel.find((f: any) => f.stage === 'NEGOTIATION');
  assert.ok(negotiation.investment >= 100000);
});
