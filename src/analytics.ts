// Аналитика (ТЗ §8): воронка этапов, сроки и узкие места согласования, инвестиции/оборот/ROI по брендам, сетям,
// кварталам и КАМ с прошлым периодом, «пульс переговоров». Всё — в пределах видимости пользователя;
// бренд-менеджер видит детально только свои бренды, остальные — одной строкой «Прочие бренды».

import { todayIso } from './time.js';
import type { Tx } from './db.js';
import { type Ctx, campaignVisibility, requirePermission } from './access.js';
import { isUuid } from './commands.js';
import { STAGES } from './campaigns.js';

type Q = Pick<Tx, 'query'>;

export interface AnalyticsQuery { year?: string; type?: string; group?: string; network?: string; owner?: string }

const r2 = (x: number) => Math.round(x * 100) / 100;
const roi = (inv: number, turn: number) => (inv > 0 ? r2(turn / inv) : null);
const growth = (now: number, prior: number) => (prior > 0 ? Math.round((now / prior - 1) * 1000) / 10 : null);
const QUARTERS = ['I кв.', 'II кв.', 'III кв.', 'IV кв.'];

/** Месяцы (1–12) года, которые покрывает ключ периода разбивки. */
function monthsOf(key: string, year: number, from: string, to: string): number[] {
  const all = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  let m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (m) return Number(m[1]) === year ? all((Number(m[2]) - 1) * 3 + 1, Number(m[2]) * 3) : [];
  m = /^(\d{4})-M(\d{2})$/.exec(key);
  if (m) return Number(m[1]) === year ? [Number(m[2])] : [];
  m = /^(\d{4})-T([1-3])$/.exec(key);
  if (m) return Number(m[1]) === year ? all((Number(m[2]) - 1) * 4 + 1, Number(m[2]) * 4) : [];
  // Весь срок кампании: месяцы пересечения с годом.
  const fy = Number(from.slice(0, 4)), ty = Number(to.slice(0, 4));
  const a = fy < year ? 1 : fy > year ? 13 : Number(from.slice(5, 7));
  const b = ty > year ? 12 : ty < year ? 0 : Number(to.slice(5, 7));
  return a <= b ? all(a, b) : [];
}

/** Сколько месяцев ключа периода всего (для равномерного распределения по кварталам). */
function spanOf(key: string, from: string, to: string): number {
  if (/-Q[1-4]$/.test(key)) return 3;
  if (/-M\d{2}$/.test(key)) return 1;
  if (/-T[1-3]$/.test(key)) return 4;
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

async function brandScope(q: Q, ctx: Ctx): Promise<Set<string> | null> {
  const s = ctx.access.scopes;
  const p = ctx.access.permissions;
  if (!s.has('BRANDS') || s.has('ALL') || s.has('SUBORDINATES') || p.has('CAMPAIGN_EDIT') || p.has('CAMPAIGN_EDIT_SUBORDINATES')) return null;
  const { rows } = await q.query<{ brand_id: string }>('select brand_id from kam.user_brand where client_id=$1 and user_id=$2', [ctx.clientId, ctx.principal.userId]);
  return new Set(rows.map((r) => r.brand_id));
}

export async function analytics(ctx: Ctx, q: AnalyticsQuery) {
  requirePermission(ctx, 'ANALYTICS');
  const year = q.year && /^\d{4}$/.test(q.year) ? Number(q.year) : Number(todayIso().slice(0, 4)) + 1;
  const vis = campaignVisibility(ctx, 3);
  const params: unknown[] = [ctx.clientId, year, ...vis.params];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = ['c.client_id = $1', vis.sql, `daterange(c.period_from, c.period_to, '[]') && daterange(make_date($2::int,1,1), make_date($2::int,12,31), '[]')`];
  if (q.type && isUuid(q.type)) where.push(`c.type_id = ${push(q.type)}`);
  if (q.network && isUuid(q.network)) where.push(`c.network_id = ${push(q.network)}`);
  if (q.owner && isUuid(q.owner)) where.push(`c.owner_id = ${push(q.owner)}`);
  if (q.group && isUuid(q.group)) where.push(`n.group_id = ${push(q.group)}`);
  const W = where.join(' and ');

  const { rows: camps } = await ctx.db.query<{
    id: string; stage: string; network_id: string; network: string; owner_id: string; owner: string; period_from: string; period_to: string;
    overdue: boolean; version_id: string | null; investment: number; turnover: number; stage_changed_at: string;
  }>(
    `select c.id, c.stage, c.network_id, n.name network, c.owner_id, u.display_name owner, c.period_from::text period_from, c.period_to::text period_to,
            (c.control_date < current_date and c.stage = any(array['PREPARATION','NEGOTIATION','APPROVAL'])) overdue,
            v.id version_id, coalesce(v.total_investment, 0)::float8 investment, coalesce(v.total_turnover, 0)::float8 turnover, c.stage_changed_at
       from kam.campaign c join kam.network n on n.client_id = c.client_id and n.id = c.network_id join kam.app_user u on u.id = c.owner_id
       left join lateral (select id, total_investment, total_turnover from kam.offer_version ov where ov.client_id = c.client_id and ov.campaign_id = c.id
                          order by number desc limit 1) v on true
      where ${W}`, params);
  const ids = camps.map((c) => c.id);
  const counted = camps.filter((c) => c.stage !== 'CANCELLED' && c.version_id);
  const versionIds = camps.filter((c) => c.version_id).map((c) => c.version_id!);
  const byCamp = new Map(camps.map((c) => [c.id, c]));

  // Единая методика: все суммы аналитики — доля текущей версии, приходящаяся на выбранный год.
  // У годовых кампаний это вся сумма; у переходящих — только месяцы этого года. Прошлый период — те же кварталы годом раньше.
  const { rows: cells } = versionIds.length ? await ctx.db.query<{ campaign_id: string; brand_id: string; brand: string; period_key: string; investment: number; turnover: number }>(
    `select v.campaign_id, x.brand_id, b.name brand, x.period_key, x.investment::float8 investment, x.turnover::float8 turnover
       from kam.offer_version_cell x join kam.offer_version v on v.client_id = x.client_id and v.id = x.version_id
       join kam.brand b on b.client_id = x.client_id and b.id = x.brand_id
      where x.client_id=$1 and x.version_id = any($2::uuid[])`, [ctx.clientId, versionIds]) : { rows: [] };
  const inYear = new Map<string, { investment: number; turnover: number }>();
  for (const x of cells) {
    const c = byCamp.get(x.campaign_id)!;
    const share = monthsOf(x.period_key, year, c.period_from, c.period_to).length / spanOf(x.period_key, c.period_from, c.period_to);
    const a = inYear.get(c.id) ?? { investment: 0, turnover: 0 };
    a.investment += x.investment * share;
    a.turnover += x.turnover * share;
    inYear.set(c.id, a);
  }
  const amt = (c: { id: string }) => inYear.get(c.id) ?? { investment: 0, turnover: 0 };
  for (const c of camps) { c.investment = amt(c).investment; c.turnover = amt(c).turnover; }

  // Воронка ---------------------------------------------------------------
  const funnel = STAGES.map((s) => {
    const list = camps.filter((c) => c.stage === s);
    return { stage: s, count: list.length, investment: r2(list.reduce((a, c) => a + c.investment, 0)), turnover: r2(list.reduce((a, c) => a + c.turnover, 0)) };
  });

  // Разбивка версий: бренд × месяц года (без отменённых кампаний) ---------------------
  const limit = await brandScope(ctx.db, ctx);
  const OTHER = 'other';
  const brandKey = (id: string) => (limit && !limit.has(id) ? OTHER : id);
  const brands = new Map<string, { brand_id: string | null; name: string; investment: number; turnover: number; prior_fact_investment: number; prior_fact_turnover: number; prior_plan_turnover: number }>();
  const brandRow = (id: string, name: string) => {
    const k = brandKey(id);
    if (!brands.has(k)) brands.set(k, { brand_id: k === OTHER ? null : id, name: k === OTHER ? 'Прочие бренды' : name, investment: 0, turnover: 0, prior_fact_investment: 0, prior_fact_turnover: 0, prior_plan_turnover: 0 });
    return brands.get(k)!;
  };
  const quarters = QUARTERS.map((label, i) => ({ quarter: i + 1, label, investment: 0, turnover: 0, prior_fact_investment: 0, prior_fact_turnover: 0 }));
  for (const x of cells) {
    const c = byCamp.get(x.campaign_id)!;
    if (c.stage === 'CANCELLED') continue;
    const b = brandRow(x.brand_id, x.brand);
    const months = monthsOf(x.period_key, year, c.period_from, c.period_to);
    const share = months.length / spanOf(x.period_key, c.period_from, c.period_to);
    b.investment += x.investment * share;
    b.turnover += x.turnover * share;
    for (const m of months) {
      const qq = quarters[Math.floor((m - 1) / 3)]!;
      qq.investment += x.investment / spanOf(x.period_key, c.period_from, c.period_to);
      qq.turnover += x.turnover / spanOf(x.period_key, c.period_from, c.period_to);
    }
  }

  // Прошлый период: факт тех же сетей в тех же кварталах годом раньше ---------------------
  // Кампания по сети на II квартал сравнивается со II кварталом прошлого года, а не со всем годом.
  const covered = new Set<string>();
  for (const c of counted) {
    for (const m of monthsOf('ALL', year, c.period_from, c.period_to)) covered.add(`${c.network_id}|${Math.floor((m - 1) / 3) + 1}`);
  }
  const networkIds = [...new Set(counted.map((c) => c.network_id))];
  const { rows: prior } = networkIds.length ? await ctx.db.query<{ network_id: string; brand_id: string; brand: string; quarter: number; fi: number; ft: number; pt: number }>(
    `select p.network_id, p.brand_id, b.name brand, p.quarter, coalesce(p.fact_investment,0)::float8 fi, coalesce(p.fact_turnover,0)::float8 ft, coalesce(p.plan_turnover,0)::float8 pt
       from kam.prior_period p join kam.brand b on b.client_id = p.client_id and b.id = p.brand_id
      where p.client_id=$1 and p.year=$2 and p.network_id = any($3::uuid[])`, [ctx.clientId, year - 1, networkIds]) : { rows: [] };
  const priorByNet = new Map<string, { fi: number; ft: number }>();
  for (const p of prior) {
    if (!covered.has(`${p.network_id}|${p.quarter}`)) continue;
    const b = brandRow(p.brand_id, p.brand);
    b.prior_fact_investment += p.fi; b.prior_fact_turnover += p.ft; b.prior_plan_turnover += p.pt;
    const qq = quarters[p.quarter - 1]!;
    qq.prior_fact_investment += p.fi; qq.prior_fact_turnover += p.ft;
    const n = priorByNet.get(p.network_id) ?? { fi: 0, ft: 0 };
    n.fi += p.fi; n.ft += p.ft;
    priorByNet.set(p.network_id, n);
  }
  const byBrand = [...brands.values()]
    .map((b) => ({
      ...b, investment: r2(b.investment), turnover: r2(b.turnover), roi: roi(b.investment, b.turnover),
      prior_fact_investment: r2(b.prior_fact_investment), prior_fact_turnover: r2(b.prior_fact_turnover), prior_roi: roi(b.prior_fact_investment, b.prior_fact_turnover),
      prior_execution_pct: b.prior_plan_turnover > 0 ? Math.round((b.prior_fact_turnover / b.prior_plan_turnover) * 1000) / 10 : null,
      growth_pct: growth(b.investment, b.prior_fact_investment),
    }))
    .filter((b) => b.investment > 0 || b.prior_fact_investment > 0)
    .sort((a, b) => (a.brand_id === null ? 1 : b.brand_id === null ? -1 : b.investment - a.investment));

  // Сети и КАМ -------------------------------------------------------------------
  const nets = new Map<string, { network_id: string; name: string; campaigns: number; investment: number; turnover: number; overdue: number }>();
  const owners = new Map<string, { owner_id: string; name: string; campaigns: number; active: number; approved: number; investment: number; turnover: number; overdue: number }>();
  for (const c of camps) {
    if (c.stage === 'CANCELLED') continue;
    const n = nets.get(c.network_id) ?? { network_id: c.network_id, name: c.network, campaigns: 0, investment: 0, turnover: 0, overdue: 0 };
    n.campaigns += 1; n.investment += c.investment; n.turnover += c.turnover; n.overdue += c.overdue ? 1 : 0;
    nets.set(c.network_id, n);
    const o = owners.get(c.owner_id) ?? { owner_id: c.owner_id, name: c.owner, campaigns: 0, active: 0, approved: 0, investment: 0, turnover: 0, overdue: 0 };
    o.campaigns += 1; o.investment += c.investment; o.turnover += c.turnover; o.overdue += c.overdue ? 1 : 0;
    if (c.stage !== 'CLOSED') o.active += 1;
    if (['APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'].includes(c.stage)) o.approved += 1;
    owners.set(c.owner_id, o);
  }
  const byNetwork = [...nets.values()].map((n) => {
    const p = priorByNet.get(n.network_id) ?? { fi: 0, ft: 0 };
    return { ...n, investment: r2(n.investment), turnover: r2(n.turnover), roi: roi(n.investment, n.turnover), prior_fact_investment: r2(p.fi), prior_roi: roi(p.fi, p.ft), growth_pct: growth(n.investment, p.fi) };
  }).sort((a, b) => b.investment - a.investment);
  const byOwner = [...owners.values()].map((o) => ({ ...o, investment: r2(o.investment), turnover: r2(o.turnover), roi: roi(o.investment, o.turnover) })).sort((a, b) => b.investment - a.investment);

  // Сроки этапов: от входа в этап до выхода (для текущего — до сегодня) ------------------------
  const { rows: stageRows } = ids.length ? await ctx.db.query<{ stage: string; days: number; open: boolean }>(
    `with ev as (
       select e.campaign_id, e.to_stage stage, e.at, lead(e.at) over (partition by e.campaign_id order by e.at, e.id) next_at
         from kam.campaign_event e where e.client_id=$1 and e.campaign_id = any($2::uuid[]) and e.kind = 'STAGE'
       union all
       select c.id, 'PREPARATION', c.created_at, (select min(e.at) from kam.campaign_event e where e.client_id = c.client_id and e.campaign_id = c.id and e.kind='STAGE')
         from kam.campaign c where c.client_id=$1 and c.id = any($2::uuid[]))
     select stage, (extract(epoch from (coalesce(next_at, now()) - at)) / 86400)::float8 days, next_at is null open from ev
      where stage not in ('CANCELLED','CLOSED')`, [ctx.clientId, ids]) : { rows: [] };
  const timing = STAGES.filter((s) => !['CANCELLED', 'CLOSED'].includes(s)).map((s) => {
    const d = stageRows.filter((r) => r.stage === s).map((r) => r.days).sort((a, b) => a - b);
    const done = stageRows.filter((r) => r.stage === s && !r.open).length;
    return { stage: s, n: d.length, finished: done, avg_days: d.length ? Math.round((d.reduce((a, x) => a + x, 0) / d.length) * 10) / 10 : null, median_days: d.length ? Math.round(d[Math.floor(d.length / 2)]! * 10) / 10 : null };
  });

  // Узкие места согласования: шаги ---------------------------------------------------------
  const { rows: steps } = ids.length ? await ctx.db.query<{ title: string; decided: number; avg_days: number | null; rejected: number; active: number; overdue: number; late: number }>(
    `select s.title, count(*) filter (where s.decided_at is not null)::int decided,
            avg(extract(epoch from (s.decided_at - s.activated_at)) / 86400) filter (where s.decided_at is not null)::float8 avg_days,
            count(*) filter (where s.status='REJECTED')::int rejected,
            count(*) filter (where s.status='ACTIVE')::int active,
            count(*) filter (where s.status='ACTIVE' and s.due_date < current_date)::int overdue,
            count(*) filter (where s.decided_at is not null and s.due_date < s.decided_at::date)::int late
       from kam.approval_step s where s.client_id=$1 and s.campaign_id = any($2::uuid[]) and s.status <> 'SKIPPED'
      group by s.title order by avg_days desc nulls last`, [ctx.clientId, ids]) : { rows: [] };
  const { rows: rounds } = ids.length ? await ctx.db.query<{ campaigns: number; first_pass: number; rounds: number; rejected: number }>(
    `select count(distinct a.campaign_id) filter (where a.status in ('APPROVED','SUPERSEDED'))::int campaigns,
            count(*) filter (where a.status in ('APPROVED','SUPERSEDED') and not exists (
              select 1 from kam.approval p where p.client_id = a.client_id and p.campaign_id = a.campaign_id and p.round < a.round and p.status = 'REJECTED'))::int first_pass,
            count(*)::int rounds, count(*) filter (where a.status='REJECTED')::int rejected
       from kam.approval a where a.client_id=$1 and a.campaign_id = any($2::uuid[])`, [ctx.clientId, ids]) : { rows: [{ campaigns: 0, first_pass: 0, rounds: 0, rejected: 0 }] };
  const rr = rounds[0]!;

  // Пульс переговоров -----------------------------------------------------------------------
  const { rows: pulse } = ids.length ? await ctx.db.query(
    `select a.id, a.campaign_id, a.kind, a.at, a.status, a.purpose, a.outcome, nc.name contact, c.title, n.name network, u.display_name owner
       from kam.activity a join kam.campaign c on c.client_id = a.client_id and c.id = a.campaign_id join kam.network n on n.client_id = c.client_id and n.id = c.network_id
       join kam.app_user u on u.id = a.created_by left join kam.network_contact nc on nc.client_id = a.client_id and nc.id = a.contact_id
      where a.client_id=$1 and a.campaign_id = any($2::uuid[]) and a.status = 'DONE' order by a.at desc limit 15`, [ctx.clientId, ids]) : { rows: [] };
  const { rows: upcoming } = ids.length ? await ctx.db.query(
    `select a.id, a.campaign_id, a.kind, a.at, a.purpose, nc.name contact, c.title, n.name network, u.display_name owner
       from kam.activity a join kam.campaign c on c.client_id = a.client_id and c.id = a.campaign_id join kam.network n on n.client_id = c.client_id and n.id = c.network_id
       join kam.app_user u on u.id = a.created_by left join kam.network_contact nc on nc.client_id = a.client_id and nc.id = a.contact_id
      where a.client_id=$1 and a.campaign_id = any($2::uuid[]) and a.status = 'PLANNED' and a.at >= now() - interval '1 day' order by a.at limit 10`, [ctx.clientId, ids]) : { rows: [] };

  const inv = counted.reduce((a, c) => a + c.investment, 0);
  const turn = counted.reduce((a, c) => a + c.turnover, 0);
  const pfi = byBrand.reduce((a, b) => a + b.prior_fact_investment, 0);
  const pft = byBrand.reduce((a, b) => a + b.prior_fact_turnover, 0);
  const active = camps.filter((c) => !['CANCELLED', 'CLOSED'].includes(c.stage));
  return {
    year, brand_limited: Boolean(limit),
    kpi: {
      campaigns: camps.length, active: active.length, cancelled: camps.filter((c) => c.stage === 'CANCELLED').length,
      approved: camps.filter((c) => ['APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'].includes(c.stage)).length,
      approved_investment: r2(counted.filter((c) => ['APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'].includes(c.stage)).reduce((a, c) => a + c.investment, 0)),
      approved_share_pct: inv > 0 ? Math.round((counted.filter((c) => ['APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'].includes(c.stage)).reduce((a, c) => a + c.investment, 0) / inv) * 100) : null,
      investment: r2(inv), turnover: r2(turn), roi: roi(inv, turn),
      prior_fact_investment: r2(pfi), prior_fact_turnover: r2(pft), prior_roi: roi(pfi, pft), growth_pct: growth(inv, pfi),
      overdue_control: camps.filter((c) => c.overdue).length, overdue_steps: steps.reduce((a, s) => a + s.overdue, 0),
      first_pass_pct: rr.campaigns ? Math.round((rr.first_pass / rr.campaigns) * 100) : null, rounds: rr.rounds, rejected_rounds: rr.rejected,
    },
    funnel, timing,
    steps: steps.map((s) => ({ ...s, avg_days: s.avg_days === null ? null : Math.round(s.avg_days * 10) / 10 })),
    by_brand: byBrand,
    by_quarter: quarters.map((qq) => ({ ...qq, investment: r2(qq.investment), turnover: r2(qq.turnover), roi: roi(qq.investment, qq.turnover), prior_fact_investment: r2(qq.prior_fact_investment), prior_fact_turnover: r2(qq.prior_fact_turnover), prior_roi: roi(qq.prior_fact_investment, qq.prior_fact_turnover) })),
    by_network: byNetwork, by_owner: byOwner,
    pulse, upcoming,
  };
}
