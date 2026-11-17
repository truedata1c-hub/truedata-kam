import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setup, api, C, multipart, type TestEnv } from './helpers.js';
import { periodsFor } from '../src/periods.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const one = async <T>(sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows[0] as T;
const brandId = async (name: string) => (await one<{ id: string }>('select id from kam.brand where name=$1', [name])).id;
const netId = async (name: string) => (await one<{ id: string }>('select id from kam.network where name=$1', [name])).id;
const typeId = async (name: string) => (await one<{ id: string }>('select id from kam.campaign_type where name=$1', [name])).id;

/** Новая кампания в переговорах у КАМ, без версий. */
async function freshCampaign(as: string, network: string, type = 'Ассортиментное соглашение', from = '2027-01-01', to = '2027-12-31') {
  const r = await call(`${C(env)}/campaigns`, { as, body: { network_id: await netId(network), type_id: await typeId(type), title: `Тест ${Math.random()}`, period_from: from, period_to: to } });
  assert.equal(r.status, 201, r.body);
  const card = await call(`${C(env)}/campaigns/${r.json.id}`, { as });
  const moved = await call(`${C(env)}/campaigns/${r.json.id}/transitions`, { as, ifMatch: card.etag, body: { action: 'START_NEGOTIATION' } });
  return { id: r.json.id as string, etag: moved.etag! };
}

test('периоды разбивки: кварталы, месяцы, четыре месяца, обрезка датами кампании', () => {
  assert.deepEqual(periodsFor('QUARTER', '2027-01-01', '2027-12-31').map((p) => p.key), ['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4']);
  const cut = periodsFor('QUARTER', '2027-02-15', '2027-05-10');
  assert.deepEqual(cut.map((p) => [p.key, p.from, p.to]), [['2027-Q1', '2027-02-15', '2027-03-31'], ['2027-Q2', '2027-04-01', '2027-05-10']]);
  assert.deepEqual(periodsFor('FOUR_MONTHS', '2027-01-01', '2027-12-31').map((p) => p.label), ['янв–апр 2027', 'май–авг 2027', 'сен–дек 2027']);
  assert.equal(periodsFor('MONTH', '2026-12-01', '2027-02-28').map((p) => p.key).join(','), '2026-M12,2027-M01,2027-M02');
  assert.deepEqual(periodsFor('WHOLE', '2027-01-01', '2027-06-30'), [{ key: 'ALL', label: 'Весь период', from: '2027-01-01', to: '2027-06-30' }]);
});

test('сценарий 5: разбивка 3 бренда × 4 квартала — итоги и ROI; шаблон Excel даёт ту же версию', async () => {
  const c = await freshCampaign('anna.smirnova', 'Ригла');
  const brands = [await brandId('Кардиовел'), await brandId('Венотон'), await brandId('Иммунорм')];
  const cells = brands.flatMap((b, i) => ['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4'].map((q, j) => ({ brand_id: b, period_key: q, investment: 100000 * (i + 1) + j * 1000, turnover: 1000000 * (i + 1) + j * 10000.55 })));
  const expectInv = cells.reduce((a, x) => a + x.investment, 0);
  const expectTurn = Math.round(cells.reduce((a, x) => a + x.turnover, 0) * 100) / 100;
  const v1 = await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'anna.smirnova', ifMatch: c.etag, body: { cells, justification: 'Рост выкладки', brand_notes: { [brands[0]!]: 'Приоритет' } } });
  assert.equal(v1.status, 201, v1.body);
  assert.equal(v1.json.number, 1);
  assert.equal(v1.json.total_investment, expectInv);
  assert.equal(v1.json.total_turnover, expectTurn);
  const view = (await call(`${C(env)}/campaigns/${c.id}/versions/current`, { as: 'anna.smirnova' })).json;
  assert.equal(view.totals.roi, Math.round((expectTurn / expectInv) * 100) / 100);
  assert.equal(view.brands.length, 3);
  assert.equal(view.periods.length, 4);
  assert.equal(view.brands.find((b: any) => b.brand_id === brands[0]).note, 'Приоритет');

  // Шаблон с текущей версией: заполняем заново и разбираем — получаем те же ячейки.
  const tpl = await env.app.inject({ method: 'GET', url: `${C(env)}/campaigns/${c.id}/versions/template.xlsx`, headers: { authorization: `Bearer ${env.tokens['anna.smirnova']}` } });
  assert.equal(tpl.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Разбивка')!;
  assert.equal(ws.getRow(1).getCell(3).value, 'inv:2027-Q1');
  const mp = multipart({}, { name: 't.xlsx', content: Buffer.from(await wb.xlsx.writeBuffer()) });
  const parsed = await env.app.inject({ method: 'POST', url: `${C(env)}/campaigns/${c.id}/versions/parse`, headers: { ...mp.headers, authorization: `Bearer ${env.tokens['anna.smirnova']}` }, payload: mp.payload });
  assert.equal(parsed.statusCode, 200, parsed.body);
  assert.deepEqual(parsed.json().issues, []);
  const sort = (a: any[]) => [...a].sort((x, y) => `${x.brand_id}${x.period_key}`.localeCompare(`${y.brand_id}${y.period_key}`));
  assert.deepEqual(sort(parsed.json().cells), sort(cells.map((x) => ({ ...x, turnover: Math.round(x.turnover * 100) / 100 }))));

  // Ошибка в ячейке и неизвестный бренд — сообщаются построчно.
  ws.getRow(3).getCell(3).value = 'много';
  ws.addRow(['', 'Неизвестный бренд', 5]);
  const bad = multipart({}, { name: 't.xlsx', content: Buffer.from(await wb.xlsx.writeBuffer()) });
  const badRes = (await env.app.inject({ method: 'POST', url: `${C(env)}/campaigns/${c.id}/versions/parse`, headers: { ...bad.headers, authorization: `Bearer ${env.tokens['anna.smirnova']}` }, payload: bad.payload })).json();
  assert.equal(badRes.issues.length, 2);
  assert.match(badRes.issues[1].message, /Неизвестный бренд/);
});

test('проверки разбивки: пусто, чужой период, отрицательная сумма; бренд без сумм отбрасывается', async () => {
  const c = await freshCampaign('dmitry.petrov', 'Неофарм');
  const b = await brandId('Нейроспан');
  const post = (cells: unknown) => call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'dmitry.petrov', ifMatch: c.etag, body: { cells } });
  assert.equal((await post([])).json.error.code, 'EMPTY_BREAKDOWN');
  assert.equal((await post([{ brand_id: b, period_key: '2026-Q1', investment: 1, turnover: 1 }])).json.error.code, 'UNKNOWN_PERIOD');
  assert.equal((await post([{ brand_id: b, period_key: '2027-Q1', investment: -5, turnover: 1 }])).json.error.code, 'INVALID_AMOUNT');
  const ok = await post([{ brand_id: b, period_key: '2027-Q1', investment: 500, turnover: 6000 }, { brand_id: await brandId('Артросил'), period_key: '2027-Q2', investment: 0, turnover: 0 }]);
  assert.equal(ok.status, 201);
  const view = (await call(`${C(env)}/campaigns/${c.id}/versions/1`, { as: 'dmitry.petrov' })).json;
  assert.deepEqual(view.brands.map((x: any) => x.name), ['Нейроспан']);
  assert.deepEqual(Object.keys(view.brands[0].cells).sort(), ['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4'], 'пустые периоды дополнены нулями');
});

test('версии неизменяемы, номера растут, устаревшая ревизия — 412, на согласовании — 409', async () => {
  const c = await freshCampaign('maria.kuznetsova', 'Горздрав');
  const b = await brandId('Гастрофикс');
  const body = (inv: number) => ({ cells: [{ brand_id: b, period_key: '2027-Q1', investment: inv, turnover: inv * 10 }] });
  const v1 = await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'maria.kuznetsova', ifMatch: c.etag, body: body(100) });
  const stale = await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'maria.kuznetsova', ifMatch: c.etag, body: body(200) });
  assert.equal(stale.status, 412);
  const v2 = await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'maria.kuznetsova', ifMatch: v1.etag, body: body(200) });
  assert.equal(v2.json.number, 2);
  await assert.rejects(env.db.query('update kam.offer_version set total_investment = 0'));
  await assert.rejects(env.db.query('delete from kam.offer_version_cell'));
  const view = (await call(`${C(env)}/campaigns/${c.id}/versions/2`, { as: 'maria.kuznetsova' })).json;
  assert.deepEqual(view.totals.previous, { investment: 100, turnover: 1000 });
  // Чужой КАМ кампанию не видит; финансовый директор видит, но версию не создаёт.
  assert.equal((await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'ilya.ivanov', ifMatch: v2.etag, body: body(1) })).status, 404);
  assert.equal((await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'igor.vasiliev', ifMatch: v2.etag, body: body(1) })).status, 403);
  const inApproval = await one<{ id: string; revision: number }>("select id, revision from kam.campaign where stage='APPROVAL' and owner_id=(select id from kam.app_user where email='maria.kuznetsova@demo.test') limit 1");
  if (inApproval) {
    const r = await call(`${C(env)}/campaigns/${inApproval.id}/versions`, { as: 'maria.kuznetsova', ifMatch: `"campaign:${inApproval.id}:${inApproval.revision}"`, body: body(1) });
    assert.equal(r.json.error.code, 'STAGE_LOCKED');
  }
});

test('сценарий 14: сравнение с прошлым периодом и подсветки; пороги меняются в настройках', async () => {
  // В демо-наборе у сетей есть план и факт 2026 по своим брендам.
  const net = await netId('Ригла');
  const p = (await env.db.query<{ brand_id: string; fi: string; ft: string }>(
    'select brand_id, sum(fact_investment) fi, sum(fact_turnover) ft from kam.prior_period where network_id=$1 and year=2026 group by brand_id order by brand_id limit 1', [net])).rows[0]!;
  const otherBrand = (await one<{ id: string }>('select id from kam.brand where id not in (select brand_id from kam.prior_period where network_id=$1) limit 1', [net])).id;
  const c = await freshCampaign('anna.smirnova', 'Ригла', 'Пересмотр условий');
  const fi = Number(p.fi);
  const ft = Number(p.ft);
  const cells = [
    // Рост инвестиций на 40 % при том же обороте: подсветка роста и падения ROI.
    ...['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4'].map((q) => ({ brand_id: p.brand_id, period_key: q, investment: Math.round((fi * 1.4) / 4), turnover: Math.round(ft / 4) })),
    { brand_id: otherBrand, period_key: '2027-Q1', investment: 1000, turnover: 9000 },
  ];
  const v = await call(`${C(env)}/campaigns/${c.id}/versions`, { as: 'anna.smirnova', ifMatch: c.etag, body: { cells } });
  assert.equal(v.status, 201, v.body);
  const view = (await call(`${C(env)}/campaigns/${c.id}/versions/current`, { as: 'anna.smirnova' })).json;
  const main = view.brands.find((b: any) => b.brand_id === p.brand_id);
  assert.equal(view.prior_label, '2026');
  assert.equal(main.prior.fact_investment, fi);
  assert.ok(main.highlights.includes('INVESTMENT_GROWTH'));
  assert.ok(main.highlights.includes('ROI_BELOW_PRIOR'));
  assert.ok(main.period_prior['2027-Q1'], 'поквартальное сравнение с тем же кварталом 2026');
  assert.deepEqual(view.brands.find((b: any) => b.brand_id === otherBrand).highlights, ['NO_PRIOR']);
  // Порог роста 50 % — подсветка роста исчезает.
  const s = await call(`${C(env)}/settings/thresholds`, { as: 'admin', method: 'PUT', body: { investment_growth_pct: 50, execution_below_pct: 90, roi_below_prior: false } });
  assert.equal(s.status, 200);
  const view2 = (await call(`${C(env)}/campaigns/${c.id}/versions/current`, { as: 'anna.smirnova' })).json;
  const main2 = view2.brands.find((b: any) => b.brand_id === p.brand_id);
  assert.ok(!main2.highlights.includes('INVESTMENT_GROWTH'));
  assert.ok(!main2.highlights.includes('ROI_BELOW_PRIOR'));
  await call(`${C(env)}/settings/thresholds`, { as: 'admin', method: 'PUT', body: { investment_growth_pct: 15, execution_below_pct: 90, roi_below_prior: true } });
});

test('сценарий 13: бренд-менеджер видит свои бренды подробно, остальные — одной строкой; итоги те же', async () => {
  const camp = await one<{ campaign_id: string; number: number }>(
    `select v.campaign_id, max(v.number) number from kam.offer_version v join kam.offer_version_cell x on x.version_id = v.id
      where x.brand_id in (select id from kam.brand where name in ('Кардиовел','Венотон')) group by v.campaign_id
      having count(distinct x.brand_id) >= 1 and (select count(distinct brand_id) from kam.offer_version_cell y where y.version_id = (select id from kam.offer_version w where w.campaign_id = v.campaign_id order by number desc limit 1)) > 2 limit 1`);
  const full = (await call(`${C(env)}/campaigns/${camp.campaign_id}/versions/current`, { as: 'igor.vasiliev' })).json;
  const limited = (await call(`${C(env)}/campaigns/${camp.campaign_id}/versions/current`, { as: 'ksenia.orlova' })).json;
  assert.equal(limited.brand_limited, true);
  assert.equal(full.brand_limited, false);
  assert.equal(limited.totals.investment, full.totals.investment);
  const names = limited.brands.map((b: any) => b.name);
  assert.ok(names.every((n: string) => ['Кардиовел', 'Венотон', 'Прочие бренды'].includes(n)));
  assert.ok(names.includes('Прочие бренды'));
});

test('портфель: суммы и ROI по текущим версиям', async () => {
  const r = (await call(`${C(env)}/campaigns`, { as: 'igor.vasiliev', query: { year: '2027', stage: 'ACTIVE' } })).json;
  const withV = r.items.filter((c: any) => c.version && c.stage !== 'CANCELLED');
  const sum = Math.round(withV.reduce((a: number, c: any) => a + c.investment, 0) * 100) / 100;
  assert.equal(r.kpi.investment, sum);
  assert.ok(r.kpi.investment > 0 && r.kpi.roi > 0);
  assert.ok(r.items.some((c: any) => c.version === null), 'кампании без версий в портфеле остаются');
});

test('прошлые периоды: шаблон, ошибки без изменений, замена года целиком', async () => {
  const auth = { authorization: `Bearer ${env.tokens.admin ?? (await env.login('admin'))}` };
  const sum = await call(`${C(env)}/prior-periods`, { as: 'admin', query: { year: '2026' } });
  const before = sum.json.networks.length;
  assert.ok(before > 20);
  const tpl = await env.app.inject({ method: 'GET', url: `${C(env)}/prior-periods/template.xlsx?year=2026`, headers: auth });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Прошлый период')!;
  const rows = ws.rowCount;
  ws.addRow(['Нет такой сети', 'Кардиовел', 2026, 1, 1, 1, 1, 1]);
  let mp = multipart({ year: '2026' }, { name: 'p.xlsx', content: Buffer.from(await wb.xlsx.writeBuffer()) });
  const bad = await env.app.inject({ method: 'POST', url: `${C(env)}/prior-periods/import`, headers: { ...mp.headers, ...auth }, payload: mp.payload });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error.details.issues[0].row, rows + 1);
  assert.equal((await call(`${C(env)}/prior-periods`, { as: 'admin', query: { year: '2026' } })).json.networks.length, before, 'данные не изменились');
  // Оставляем одну сеть — после загрузки за 2026 год остаётся только она.
  const keep = ws.getRow(2).getCell(1).value as string;
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Прошлый период');
  ws.eachRow((row, i) => { if (i === 1 || row.getCell(1).value === keep) ws2.addRow((row.values as unknown[]).slice(1)); });
  mp = multipart({ year: '2026' }, { name: 'p.xlsx', content: Buffer.from(await wb2.xlsx.writeBuffer()) });
  const ok = await env.app.inject({ method: 'POST', url: `${C(env)}/prior-periods/import`, headers: { ...mp.headers, ...auth }, payload: mp.payload });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual((await call(`${C(env)}/prior-periods`, { as: 'admin', query: { year: '2026' } })).json.networks.map((n: any) => n.network), [keep]);
  assert.equal((await call(`${C(env)}/prior-periods`, { as: 'anna.smirnova' })).status, 403);
});
