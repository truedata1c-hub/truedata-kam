import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, api, C, type TestEnv } from './helpers.js';
import { addWorkdays } from '../src/approval.js';

let env: TestEnv;
let call: ReturnType<typeof api>;
before(async () => { env = await setup(); call = api(env); });
after(async () => { await env.close(); });

const one = async <T>(sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows[0] as T;
const id = async (table: string, name: string, col = 'name') => (await one<{ id: string }>(`select id from kam.${table} where ${col}=$1`, [name])).id;
const userId = (login: string) => id('app_user', `${login}@demo.test`, 'email');

async function etag(cid: string, as: string) { return (await call(`${C(env)}/campaigns/${cid}`, { as })).etag!; }

/** Кампания в переговорах с версией: инвестиции и оборот — по одному бренду на весь период. */
async function campaignWithVersion(as: string, network: string, type: string, investment: number, opts: { justification?: string; from?: string; to?: string } = {}) {
  const from = opts.from ?? '2027-01-01', to = opts.to ?? '2027-12-31';
  const r = await call(`${C(env)}/campaigns`, { as, body: { network_id: await id('network', network), type_id: await id('campaign_type', type), title: `Тест ${Math.random()}`, period_from: from, period_to: to } });
  assert.equal(r.status, 201, r.body);
  const cid = r.json.id as string;
  const moved = await call(`${C(env)}/campaigns/${cid}/transitions`, { as, ifMatch: await etag(cid, as), body: { action: 'START_NEGOTIATION' } });
  assert.equal(moved.status, 200, moved.body);
  await addVersion(as, cid, investment, opts.justification ?? 'Рост сети');
  return cid;
}

async function addVersion(as: string, cid: string, investment: number, justification = 'Обновлено', turnoverRatio = 10) {
  const draft = (await call(`${C(env)}/campaigns/${cid}/versions/draft`, { as })).json;
  const brand = await id('brand', 'Кардиовел');
  const per = investment / draft.periods.length;
  const cells = draft.periods.map((p: { key: string }) => ({ brand_id: brand, period_key: p.key, investment: per, turnover: per * turnoverRatio }));
  const v = await call(`${C(env)}/campaigns/${cid}/versions`, { as, ifMatch: await etag(cid, as), body: { cells, justification } });
  assert.equal(v.status, 201, v.body);
  return v.json;
}

const submit = async (as: string, cid: string) => call(`${C(env)}/campaigns/${cid}/approval/submit`, { as, ifMatch: await etag(cid, as), body: {} });
const decide = async (as: string, cid: string, decision: string, comment?: string) =>
  call(`${C(env)}/campaigns/${cid}/approval/decision`, { as, ifMatch: await etag(cid, as), body: { decision, comment } });
const approvalOf = async (as: string, cid: string) => (await call(`${C(env)}/campaigns/${cid}/approval`, { as })).json;

test('рабочие дни: срок решения пропускает выходные', () => {
  assert.equal(addWorkdays('2026-11-20', 1), '2026-11-23'); // пятница + 1 → понедельник
  assert.equal(addWorkdays('2026-11-17', 3), '2026-11-20');
  assert.equal(addWorkdays('2026-11-21', 5), '2026-11-27');
});

test('сценарий 7: годовые условия на 6 млн ₽ — шаг финансового директора пропущен; предпросмотр совпадает с отправкой', async () => {
  const cid = await campaignWithVersion('anna.smirnova', 'Ригла', 'Годовые условия', 6_000_000);
  const pre = await approvalOf('anna.smirnova', cid);
  assert.equal(pre.preview.template.name, 'Годовые условия');
  assert.deepEqual(pre.preview.problems, []);
  assert.deepEqual(pre.preview.steps.map((s: any) => [s.title, s.included, s.candidates.map((c: any) => c.name)]), [
    ['Руководитель КАМ', true, ['Елена Соколова']],
    ['Национальный руководитель', true, ['Ольга Морозова']],
    ['Финансовый директор', false, []],
  ]);
  assert.match(pre.preview.steps[2].skip_reason, /меньше порога 10,0 млн ₽/);
  const s = await submit('anna.smirnova', cid);
  assert.equal(s.status, 201, s.body);
  assert.equal(s.json.stage, 'APPROVAL');
  const a = await approvalOf('anna.smirnova', cid);
  assert.deepEqual(a.current.steps.map((x: any) => x.status), ['ACTIVE', 'WAITING', 'SKIPPED']);
  assert.ok(a.current.steps[0].due_date);
  assert.equal(a.my_decision, null);
  assert.equal(a.can_withdraw, true);

  // Крупная версия включает финансового директора; он в отпуске — в предпросмотре виден заместитель.
  const big = await campaignWithVersion('anna.smirnova', 'АСНА', 'Годовые условия', 25_000_000);
  const p2 = await approvalOf('anna.smirnova', big);
  assert.equal(p2.preview.steps[2].included, true);
  assert.deepEqual(p2.preview.steps[2].candidates.map((c: any) => c.name), ['Игорь Васильев']);
});

test('сценарии 11 и 8: автор не решает, отклонение только с комментарием, повтор той же версии запрещён', async () => {
  const cid = await campaignWithVersion('anna.smirnova', 'Мелодия здоровья', 'Ассортиментное соглашение', 1_000_000);
  assert.equal((await submit('anna.smirnova', cid)).status, 201);
  assert.equal((await decide('anna.smirnova', cid, 'APPROVE')).json?.error.code, 'SELF_APPROVAL');
  // Ольга видит кампанию (подчинённые), но исполнитель шага — Елена.
  assert.equal((await decide('olga.morozova', cid, 'APPROVE')).status, 403);
  // Отзыв до первого решения и повторная отправка той же версии.
  const w = await call(`${C(env)}/campaigns/${cid}/approval/withdraw`, { as: 'anna.smirnova', ifMatch: await etag(cid, 'anna.smirnova'), body: {} });
  assert.equal(w.status, 200, w.body);
  assert.equal(w.json.stage, 'NEGOTIATION');
  assert.equal((await submit('anna.smirnova', cid)).status, 201);

  const noComment = await decide('elena.sokolova', cid, 'REJECT', '  ');
  assert.equal(noComment.status, 422);
  assert.equal(noComment.json.error.field, 'comment');
  const rej = await decide('elena.sokolova', cid, 'REJECT', 'Снизьте ставку');
  assert.equal(rej.status, 200, rej.body);
  assert.equal(rej.json.stage, 'NEGOTIATION');
  const again = await submit('anna.smirnova', cid);
  assert.equal(again.status, 422);
  assert.equal(again.json.error.code, 'VERSION_REJECTED');
  const pre = await approvalOf('anna.smirnova', cid);
  assert.ok(pre.preview.problems.some((p: string) => p.includes('отклонили')));
  await addVersion('anna.smirnova', cid, 900_000);
  const ok = await submit('anna.smirnova', cid);
  assert.equal(ok.status, 201);
  const view = await approvalOf('elena.sokolova', cid);
  assert.equal(view.rounds.length, 3);
  assert.deepEqual(view.rounds.map((r: any) => r.status), ['IN_PROGRESS', 'REJECTED', 'WITHDRAWN']);
  assert.ok(view.my_decision);
});

test('сценарий 6: отправка без версии или без обоснования — 422', async () => {
  const r = await call(`${C(env)}/campaigns`, { as: 'dmitry.petrov', body: { network_id: await id('network', 'Неофарм'), type_id: await id('campaign_type', 'Ассортиментное соглашение'), title: 'Без версии', period_from: '2027-01-01', period_to: '2027-06-30' } });
  const cid = r.json.id;
  await call(`${C(env)}/campaigns/${cid}/transitions`, { as: 'dmitry.petrov', ifMatch: await etag(cid, 'dmitry.petrov'), body: { action: 'START_NEGOTIATION' } });
  assert.equal((await submit('dmitry.petrov', cid)).json.error.code, 'VERSION_REQUIRED');
  await addVersion('dmitry.petrov', cid, 500_000, '');
  assert.equal((await submit('dmitry.petrov', cid)).json.error.code, 'JUSTIFICATION_REQUIRED');
});

test('полный маршрут, «Мои решения», отзыв после решения запрещён; сценарий 12: новая версия после согласования', async () => {
  const cid = await campaignWithVersion('ilya.ivanov', 'Норман', 'Годовые условия', 4_000_000);
  assert.equal((await submit('ilya.ivanov', cid)).status, 201);
  const queue = await call(`${C(env)}/my-decisions`, { as: 'sergey.volkov' });
  assert.ok(queue.json.items.some((x: any) => x.campaign_id === cid && x.step_title === 'Руководитель КАМ'));
  const count = await call(`${C(env)}/my-decisions/count`, { as: 'sergey.volkov' });
  assert.ok(count.json.pending >= 1);
  assert.equal((await decide('sergey.volkov', cid, 'APPROVE', 'Ок')).json.stage, 'APPROVAL');
  const w = await call(`${C(env)}/campaigns/${cid}/approval/withdraw`, { as: 'ilya.ivanov', ifMatch: await etag(cid, 'ilya.ivanov'), body: {} });
  assert.equal(w.json.error.code, 'ALREADY_DECIDED');
  // Устаревшая ревизия не проходит.
  const stale = await call(`${C(env)}/campaigns/${cid}/approval/decision`, { as: 'olga.morozova', ifMatch: '"campaign:x:1"', body: { decision: 'APPROVE' } });
  assert.equal(stale.status, 412);
  assert.equal((await decide('olga.morozova', cid, 'APPROVE')).json.stage, 'APPROVED');
  const done = await call(`${C(env)}/my-decisions`, { as: 'olga.morozova', query: { status: 'done' } });
  assert.ok(done.json.items.some((x: any) => x.campaign_id === cid));

  // Допуски шаблона «Годовые условия» в демо: инвестиции +2 %, оборот −5 %.
  const within = await addVersion('ilya.ivanov', cid, 4_050_000, 'Мелкая правка');
  assert.equal(within.stage, 'APPROVED');
  assert.equal(within.tolerance.within, true);
  const grown = await addVersion('ilya.ivanov', cid, 5_000_000, 'Рост');
  assert.equal(grown.stage, 'NEGOTIATION');
  assert.match(grown.tolerance.reason, /вне допусков/);
  const card = await call(`${C(env)}/campaigns/${cid}`, { as: 'ilya.ivanov' });
  assert.equal(card.json.stage, 'NEGOTIATION');
  assert.ok(card.json.actions.includes('SUBMIT'));
});

test('сценарии 2, 9 и 10: роль из конструктора в шаблоне, правка шаблона не меняет идущий маршрут, заместитель решает за исполнителя', async () => {
  // Администратор заводит роль «Ценовой комитет» и даёт её КАМ другой группы (область — только свои сети).
  const role = await call(`${C(env)}/roles`, { as: 'admin', body: { name: 'Ценовой комитет', permissions: ['APPROVE'], scope: 'OWN' } });
  assert.equal(role.status, 201, role.body);
  const ilya = await userId('ilya.ivanov');
  const users = (await call(`${C(env)}/users`, { as: 'admin' })).json.items;
  const ilyaRoles = users.find((u: any) => u.id === ilya).role_ids;
  assert.equal((await call(`${C(env)}/users/${ilya}`, { method: 'PATCH', as: 'admin', body: { role_ids: [...ilyaRoles, role.json.id] } })).status, 200);

  // Роль без права согласования в шаг не ставится.
  const brandRole = await id('business_role', 'Бренд-менеджер');
  const bad = await call(`${C(env)}/route-templates`, { as: 'admin', body: { name: 'Плохой', steps: [{ title: 'X', assignee: { kind: 'ROLE', role_id: brandRole }, deadline_days: 2 }] } });
  assert.equal(bad.json.error.code, 'ROLE_CANNOT_APPROVE');

  const tpl = await call(`${C(env)}/route-templates`, { as: 'admin', body: {
    name: 'Пересмотр с комитетом', tolerance_investment_pct: 0,
    steps: [
      { title: 'Руководитель КАМ', assignee: { kind: 'MANAGER', level: 1 }, deadline_days: 2 },
      { title: 'Ценовой комитет', assignee: { kind: 'ROLE', role_id: role.json.id }, conditions: [{ kind: 'INVESTMENT_GTE', amount: 100000 }], deadline_days: 3 },
    ] } });
  assert.equal(tpl.status, 201, tpl.body);
  const list = (await call(`${C(env)}/route-templates`, { as: 'admin' })).json;
  const rules = list.rules.map((r: any) => ({ template_id: r.template_id, campaign_type_id: r.campaign_type_id, network_group_id: r.network_group_id }));
  const review = await id('campaign_type', 'Пересмотр условий');
  const saved = await call(`${C(env)}/route-rules`, { method: 'PUT', as: 'admin', body: { rules: [{ template_id: tpl.json.id, campaign_type_id: review }, ...rules] } });
  assert.equal(saved.status, 200, saved.body);

  // Роль с полномочием в маршруте нельзя лишить права согласования.
  const strip = await call(`${C(env)}/roles/${role.json.id}`, { method: 'PUT', as: 'admin', body: { name: 'Ценовой комитет', permissions: [], scope: 'OWN' } });
  assert.equal(strip.json.error.code, 'ROLE_IN_ROUTE');

  // Предпросмотр на кампании Анны: шаг уходит Илье.
  const cid = await campaignWithVersion('anna.smirnova', 'Ригла', 'Пересмотр условий', 300_000, { from: '2027-01-01', to: '2027-03-31' });
  const prev = await call(`${C(env)}/route-templates/preview`, { as: 'admin', body: { campaign_id: cid, steps: list.items.find((t: any) => t.name === 'По умолчанию').steps } });
  assert.equal(prev.status, 200, prev.body);
  assert.equal(prev.json.steps.length, 1);
  // Илья (только свои сети) до отправки кампанию Анны не видит.
  assert.equal((await call(`${C(env)}/campaigns/${cid}`, { as: 'ilya.ivanov' })).status, 404);
  assert.equal((await submit('anna.smirnova', cid)).status, 201);
  const a = await approvalOf('anna.smirnova', cid);
  assert.equal(a.current.template_name, 'Пересмотр с комитетом');
  assert.deepEqual(a.current.steps[1].candidate_users.map((u: any) => u.name), ['Илья Иванов']);

  // Сценарий 9: шаблон правят во время согласования — идущий маршрут не меняется.
  const full = (await call(`${C(env)}/route-templates`, { as: 'admin' })).json.items.find((t: any) => t.id === tpl.json.id);
  const upd = await call(`${C(env)}/route-templates/${tpl.json.id}`, { method: 'PUT', as: 'admin', body: { ...full, steps: [full.steps[0]] } });
  assert.equal(upd.status, 200, upd.body);
  assert.equal((await approvalOf('anna.smirnova', cid)).current.steps.length, 2);

  assert.equal((await decide('elena.sokolova', cid, 'APPROVE')).status, 200);
  // Сценарий 10: Илья в отпуске, замещает Алексей; Алексей видит шаг и решает «за Илью».
  const sub = await call(`${C(env)}/substitutions`, { as: 'ilya.ivanov', body: { deputy_id: await userId('alexey.novikov'), from: '2026-01-01', to: '2030-12-31', comment: 'Отпуск' } });
  assert.equal(sub.status, 201, sub.body);
  const overlap = await call(`${C(env)}/substitutions`, { as: 'ilya.ivanov', body: { deputy_id: await userId('tatiana.lebedeva'), from: '2027-01-01', to: '2027-01-10' } });
  assert.equal(overlap.json.error.code, 'PERIOD_OVERLAP');
  const notMine = await call(`${C(env)}/substitutions`, { as: 'ilya.ivanov', body: { user_id: await userId('anna.smirnova'), deputy_id: ilya, from: '2027-01-01', to: '2027-01-10' } });
  assert.equal(notMine.status, 403);
  const q = await call(`${C(env)}/my-decisions`, { as: 'alexey.novikov' });
  const item = q.json.items.find((x: any) => x.campaign_id === cid);
  assert.equal(item.on_behalf_of, 'Илья Иванов');
  const viaDeputy = await approvalOf('alexey.novikov', cid);
  assert.equal(viaDeputy.my_decision.for_user, 'Илья Иванов');
  assert.equal((await decide('alexey.novikov', cid, 'APPROVE', 'За Илью')).json.stage, 'APPROVED');
  const fin = await approvalOf('anna.smirnova', cid);
  const st = fin.rounds[0].steps[1];
  assert.equal(st.decided_by_name, 'Алексей Новиков');
  assert.equal(st.decided_for_name, 'Илья Иванов');
  const ev = (await call(`${C(env)}/campaigns/${cid}`, { as: 'anna.smirnova' })).json.events.find((e: any) => e.kind === 'APPROVAL_DECISION' && e.payload.step === 2);
  assert.equal(ev.payload.for_user, ilya);
  assert.equal(ev.actor_name, 'Алексей Новиков');
});

test('шаблоны: шаблон по умолчанию обязателен, удаление шаблона из правил запрещено, отмена закрывает согласование, чужой клиент — 404', async () => {
  const list = (await call(`${C(env)}/route-templates`, { as: 'admin' })).json;
  const def = list.items.find((t: any) => t.is_default);
  const off = await call(`${C(env)}/route-templates/${def.id}`, { method: 'PUT', as: 'admin', body: { ...def, is_default: false } });
  assert.equal(off.json.error.code, 'DEFAULT_REQUIRED');
  const inRule = list.items.find((t: any) => t.name === 'Разовая акция');
  assert.equal((await call(`${C(env)}/route-templates/${inRule.id}/archive`, { as: 'admin', body: {} })).json.error.code, 'TEMPLATE_IN_USE');
  assert.equal((await call(`${C(env)}/route-templates`, { as: 'anna.smirnova' })).status, 403);

  const cid = await campaignWithVersion('maria.kuznetsova', 'Озерки', 'Ассортиментное соглашение', 700_000);
  assert.equal((await submit('maria.kuznetsova', cid)).status, 201);
  const cancel = await call(`${C(env)}/campaigns/${cid}/transitions`, { as: 'maria.kuznetsova', ifMatch: await etag(cid, 'maria.kuznetsova'), body: { action: 'CANCEL', comment: 'Сеть отказалась' } });
  assert.equal(cancel.status, 200, cancel.body);
  const a = await approvalOf('maria.kuznetsova', cid);
  assert.equal(a.current, null);
  assert.equal(a.rounds[0].status, 'CANCELLED');
  assert.equal((await call(`${C(env, env.other)}/my-decisions`, { as: 'elena.sokolova' })).status, 404);
  assert.equal((await call(`${C(env, env.other)}/campaigns/${cid}/approval`, { as: 'admin@other.test' })).status, 404);
});

test('демо-набор: идущие согласования с исполнителями, отклонённые раунды и замещение финансового директора', async () => {
  const n = await one<{ inprog: number; rejected: number; subs: number }>(
    `select (select count(*)::int from kam.approval where status='IN_PROGRESS') inprog, (select count(*)::int from kam.approval where status='REJECTED') rejected,
            (select count(*)::int from kam.substitution s join kam.app_user u on u.id = s.user_id where u.email like 'igor.vasiliev@%' and valid @> date '2026-11-17') subs`);
  assert.ok(n.inprog >= 8);
  assert.ok(n.rejected >= 5);
  assert.equal(n.subs, 1);
  const bad = await one<{ n: number }>(`select count(*)::int n from kam.campaign c where c.stage='APPROVAL' and not exists (select 1 from kam.approval a where a.campaign_id=c.id and a.status='IN_PROGRESS')`);
  assert.equal(bad.n, 0);
});
