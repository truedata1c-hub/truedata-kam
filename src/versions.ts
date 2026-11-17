// Версии предложения (ТЗ §6.2–6.3): разбивка бренд × период, ROI, обоснование, сравнение с прошлым периодом и подсветки.

import { randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { ApiError, forbidden, invalid, notFound } from './errors.js';
import { type Ctx, campaignVisibility, canEditFor } from './access.js';
import { type CommandResult, audit, bumpCampaign, campaignEtag, campaignEvent, isUuid, lockCampaign } from './commands.js';
import { type Period, type Split, periodsFor, quartersOf, yearBack } from './periods.js';
import { thresholds, type Thresholds } from './settings.js';
import { checkTolerance, notifyVersionChanged } from './approval.js';

const VERSION_STAGES = ['PREPARATION', 'NEGOTIATION', 'APPROVED'];
const MAX_AMOUNT = 1e12;

export const roi = (inv: number, turn: number) => (inv > 0 ? Math.round((turn / inv) * 100) / 100 : null);
const money = (v: unknown) => Math.round(Number(v) * 100) / 100;

type Q = Pick<Tx, 'query'>;

interface CampaignRow { id: string; owner_id: string; network_id: string; stage: string; period_from: string; period_to: string; period_split: Split }

async function campaignFor(q: Q, ctx: Ctx, id: string): Promise<CampaignRow> {
  if (!isUuid(id)) throw notFound();
  const vis = campaignVisibility(ctx, 3);
  const { rows } = await q.query<CampaignRow>(
    `select c.id, c.owner_id, c.network_id, c.stage, c.period_from, c.period_to, t.period_split
       from kam.campaign c join kam.campaign_type t on t.client_id = c.client_id and t.id = c.type_id
      where c.client_id=$1 and c.id=$2 and ${vis.sql}`, [ctx.clientId, id, ...vis.params]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export const campaignPeriods = (c: Pick<CampaignRow, 'period_split' | 'period_from' | 'period_to'>) => periodsFor(c.period_split, c.period_from, c.period_to);

// Создание версии -----------------------------------------------------------

export interface CellInput { brand_id: string; period_key: string; investment: number; turnover: number }

/** Проверяет и дополняет разбивку: только известные периоды и действующие бренды; у бренда заполнены все периоды. */
export async function normalizeCells(q: Q, clientId: string, periods: Period[], raw: unknown): Promise<CellInput[]> {
  if (!Array.isArray(raw)) throw invalid('cells', 'Передайте разбивку по брендам и периодам.');
  const keys = new Set(periods.map((p) => p.key));
  const seen = new Set<string>();
  const byBrand = new Map<string, Map<string, { investment: number; turnover: number }>>();
  for (const [i, c] of raw.entries()) {
    const cell = c as Record<string, unknown>;
    if (!isUuid(cell?.brand_id)) throw invalid('cells', `Строка ${i + 1}: не указан бренд.`);
    if (typeof cell.period_key !== 'string' || !keys.has(cell.period_key)) throw invalid('cells', `Строка ${i + 1}: период не относится к кампании.`, 'UNKNOWN_PERIOD');
    const id = `${cell.brand_id}|${cell.period_key}`;
    if (seen.has(id)) throw invalid('cells', 'Ячейка разбивки указана дважды.', 'DUPLICATE_CELL');
    seen.add(id);
    const vals = { investment: 0, turnover: 0 };
    for (const k of ['investment', 'turnover'] as const) {
      const v = cell[k] === undefined || cell[k] === null || cell[k] === '' ? 0 : Number(cell[k]);
      if (!Number.isFinite(v) || v < 0 || v > MAX_AMOUNT) throw invalid('cells', 'Суммы — неотрицательные числа не больше триллиона рублей.', 'INVALID_AMOUNT');
      vals[k] = money(v);
    }
    if (!byBrand.has(cell.brand_id)) byBrand.set(cell.brand_id, new Map());
    byBrand.get(cell.brand_id)!.set(cell.period_key, vals);
  }
  // Бренд без сумм в разбивку не попадает.
  for (const [b, m] of byBrand) if ([...m.values()].every((v) => !v.investment && !v.turnover)) byBrand.delete(b);
  if (!byBrand.size) throw invalid('cells', 'Заполните инвестиции или оборот хотя бы по одному бренду.', 'EMPTY_BREAKDOWN');
  const ids = [...byBrand.keys()];
  const { rows } = await q.query<{ id: string }>('select id from kam.brand where client_id=$1 and not archived and id = any($2::uuid[])', [clientId, ids]);
  if (rows.length !== ids.length) throw invalid('cells', 'Бренд не найден или в архиве.', 'UNKNOWN_BRAND');
  const out: CellInput[] = [];
  for (const [brand_id, m] of byBrand) {
    for (const p of periods) {
      const v = m.get(p.key) ?? { investment: 0, turnover: 0 };
      out.push({ brand_id, period_key: p.key, ...v });
    }
  }
  return out;
}

export async function createVersion(tx: Tx, ctx: Ctx, campaignId: string, ifMatch: string | undefined, b: Record<string, unknown>): Promise<CommandResult> {
  await lockCampaign(tx, ctx, campaignId, ifMatch);
  const c = await campaignFor(tx, ctx, campaignId);
  if (!canEditFor(ctx, c.owner_id)) throw forbidden();
  if (!VERSION_STAGES.includes(c.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Новую версию можно добавить на этапах подготовки, переговоров и «Согласовано внутри». На согласовании сначала отзовите отправку.');
  const periods = campaignPeriods(c);
  const cells = await normalizeCells(tx, ctx.clientId, periods, b.cells);
  const justification = typeof b.justification === 'string' ? b.justification.trim() : '';
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (justification.length > 5000) throw invalid('justification', 'Не длиннее 5000 символов.');
  if (comment.length > 2000) throw invalid('comment', 'Не длиннее 2000 символов.');
  const notes: [string, string][] = [];
  if (b.brand_notes !== undefined) {
    if (!b.brand_notes || typeof b.brand_notes !== 'object' || Array.isArray(b.brand_notes)) throw invalid('brand_notes', 'Некорректные комментарии по брендам.');
    const brands = new Set(cells.map((x) => x.brand_id));
    for (const [k, v] of Object.entries(b.brand_notes as Record<string, unknown>)) {
      const note = typeof v === 'string' ? v.trim() : '';
      if (!note) continue;
      if (!brands.has(k)) throw invalid('brand_notes', 'Комментарий к бренду, которого нет в разбивке.');
      if (note.length > 1000) throw invalid('brand_notes', 'Комментарий к бренду — не длиннее 1000 символов.');
      notes.push([k, note]);
    }
  }
  let docs: string[] = [];
  if (b.document_ids !== undefined) {
    if (!Array.isArray(b.document_ids) || !b.document_ids.every(isUuid)) throw invalid('document_ids', 'Некорректный список документов.');
    docs = [...new Set(b.document_ids as string[])];
    const ok = await tx.query('select 1 from kam.document where client_id=$1 and campaign_id=$2 and archived_at is null and id = any($3::uuid[])', [ctx.clientId, campaignId, docs]);
    if (ok.rowCount !== docs.length) throw invalid('document_ids', 'Документ не относится к кампании или в архиве.');
  }
  const totalInv = money(cells.reduce((a, x) => a + x.investment, 0));
  const totalTurn = money(cells.reduce((a, x) => a + x.turnover, 0));
  const number = ((await tx.query<{ n: number }>('select coalesce(max(number),0)::int n from kam.offer_version where client_id=$1 and campaign_id=$2', [ctx.clientId, campaignId])).rows[0]!.n) + 1;
  const id = randomUUID();
  await tx.query(
    `insert into kam.offer_version(client_id, id, campaign_id, number, periods, total_investment, total_turnover, justification, comment, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.clientId, id, campaignId, number, JSON.stringify(periods), totalInv, totalTurn, justification, comment, ctx.principal.userId]);
  // Одной вставкой: разбивка 10 брендов × 12 месяцев — 120 строк.
  await tx.query(
    `insert into kam.offer_version_cell(client_id, version_id, brand_id, period_key, investment, turnover)
     select $1, $2, x.brand_id, x.period_key, x.investment, x.turnover
       from jsonb_to_recordset($3::jsonb) as x(brand_id uuid, period_key text, investment numeric, turnover numeric)`,
    [ctx.clientId, id, JSON.stringify(cells)]);
  for (const [brand, note] of notes) await tx.query('insert into kam.offer_version_brand_note(client_id, version_id, brand_id, note) values ($1,$2,$3,$4)', [ctx.clientId, id, brand, note]);
  for (const d of docs) await tx.query('insert into kam.offer_version_document(client_id, version_id, document_id) values ($1,$2,$3)', [ctx.clientId, id, d]);
  await campaignEvent(tx, ctx, campaignId, 'VERSION_CREATED', { comment: comment || null, payload: { number, total_investment: totalInv, total_turnover: totalTurn } });
  // После «Согласовано внутри»: в допусках этап сохраняется, иначе кампания возвращается в переговоры (ТЗ §4).
  let stage = c.stage;
  let tolerance: { within: boolean; reason: string } | null = null;
  if (c.stage === 'APPROVED') {
    tolerance = await checkTolerance(tx, ctx.clientId, campaignId, totalInv, totalTurn);
    if (tolerance.within) await campaignEvent(tx, ctx, campaignId, 'VERSION_WITHIN_TOLERANCE', { comment: tolerance.reason, payload: { number } });
    else {
      await tx.query("update kam.approval set status='SUPERSEDED' where client_id=$1 and campaign_id=$2 and status='APPROVED'", [ctx.clientId, campaignId]);
      await tx.query("update kam.campaign set stage='NEGOTIATION', stage_changed_at=now() where client_id=$1 and id=$2", [ctx.clientId, campaignId]);
      await campaignEvent(tx, ctx, campaignId, 'STAGE', { from: 'APPROVED', to: 'NEGOTIATION', comment: tolerance.reason });
      stage = 'NEGOTIATION';
    }
    await notifyVersionChanged(tx, ctx, campaignId, number, tolerance.reason);
  }
  const rev = await bumpCampaign(tx, ctx, campaignId);
  await audit(tx, ctx, { entityType: 'version', entityId: id, action: 'CREATE', after: { campaign_id: campaignId, number, total_investment: totalInv, total_turnover: totalTurn, brands: new Set(cells.map((x) => x.brand_id)).size } });
  return { status: 201, body: { id, number, total_investment: totalInv, total_turnover: totalTurn, stage, tolerance }, etag: campaignEtag(campaignId, rev) };
}

// Чтение версии ------------------------------------------------------------

interface PriorAgg { plan_investment: number | null; fact_investment: number | null; plan_turnover: number | null; fact_turnover: number | null }

function priorView(p: PriorAgg | undefined) {
  if (!p) return null;
  const fact_roi = p.fact_investment && p.fact_turnover !== null ? roi(p.fact_investment, p.fact_turnover) : null;
  const plan_roi = p.plan_investment && p.plan_turnover !== null ? roi(p.plan_investment, p.plan_turnover) : null;
  const execution = p.plan_turnover && p.fact_turnover !== null ? Math.round((p.fact_turnover / p.plan_turnover) * 1000) / 10 : null;
  return { ...p, plan_roi, fact_roi, execution_pct: execution };
}

export function highlightsFor(t: Thresholds, cur: { investment: number; turnover: number }, prior: ReturnType<typeof priorView>): string[] {
  if (!prior) return ['NO_PRIOR'];
  const h: string[] = [];
  const r = roi(cur.investment, cur.turnover);
  if (prior.fact_investment && cur.investment > prior.fact_investment * (1 + t.investment_growth_pct / 100)) h.push('INVESTMENT_GROWTH');
  if (!prior.fact_investment && cur.investment > 0) h.push('INVESTMENT_NEW');
  if (t.roi_below_prior && r !== null && prior.fact_roi !== null && r < prior.fact_roi) h.push('ROI_BELOW_PRIOR');
  if (prior.execution_pct !== null && prior.execution_pct < t.execution_below_pct) h.push('PRIOR_UNDERPERFORMED');
  return h;
}

/** Прошлый период сети по брендам: те же календарные кварталы годом раньше. */
async function priorFor(q: Q, clientId: string, networkId: string, from: string, to: string) {
  const qs = quartersOf(yearBack(from), yearBack(to));
  if (!qs.length) return { byBrand: new Map<string, PriorAgg>(), byBrandQuarter: new Map<string, PriorAgg>(), label: '' };
  const { rows } = await q.query<{ brand_id: string; year: number; quarter: number } & Record<keyof PriorAgg, string | null>>(
    `select brand_id, year, quarter, plan_investment, fact_investment, plan_turnover, fact_turnover from kam.prior_period
      where client_id=$1 and network_id=$2 and (year, quarter) in (select * from unnest($3::int[], $4::int[]))`,
    [clientId, networkId, qs.map((x) => x.year), qs.map((x) => x.quarter)]);
  const add = (m: Map<string, PriorAgg>, k: string, r: (typeof rows)[number]) => {
    const cur = m.get(k) ?? { plan_investment: null, fact_investment: null, plan_turnover: null, fact_turnover: null };
    for (const f of ['plan_investment', 'fact_investment', 'plan_turnover', 'fact_turnover'] as const) {
      if (r[f] !== null) cur[f] = money((cur[f] ?? 0) + Number(r[f]));
    }
    m.set(k, cur);
  };
  const byBrand = new Map<string, PriorAgg>();
  const byBrandQuarter = new Map<string, PriorAgg>();
  for (const r of rows) {
    add(byBrand, r.brand_id, r);
    add(byBrand, '*', r);
    add(byBrandQuarter, `${r.brand_id}|${r.year + 1}-Q${r.quarter}`, r);
  }
  const years = [...new Set(qs.map((x) => x.year))];
  return { byBrand, byBrandQuarter, label: years.length === 1 ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}` };
}

/** Бренд-менеджер (область «свои бренды», без права вести кампанию) видит свои бренды подробно, остальные — итогом. */
async function brandLimit(q: Q, ctx: Ctx, ownerId: string): Promise<Set<string> | null> {
  const s = ctx.access.scopes;
  if (!s.has('BRANDS') || s.has('ALL') || s.has('SUBORDINATES') || canEditFor(ctx, ownerId)) return null;
  const { rows } = await q.query<{ brand_id: string }>('select brand_id from kam.user_brand where client_id=$1 and user_id=$2', [ctx.clientId, ctx.principal.userId]);
  return new Set(rows.map((r) => r.brand_id));
}

export async function listVersions(ctx: Ctx, campaignId: string) {
  await campaignFor(ctx.db, ctx, campaignId);
  const { rows } = await ctx.db.query(
    `select v.number, v.created_at, u.display_name author, v.total_investment::float8 investment, v.total_turnover::float8 turnover, v.comment,
            (select count(*)::int from kam.offer_version_document d where d.client_id = v.client_id and d.version_id = v.id) documents,
            (select count(distinct brand_id)::int from kam.offer_version_cell x where x.client_id = v.client_id and x.version_id = v.id) brands
       from kam.offer_version v join kam.app_user u on u.id = v.created_by
      where v.client_id=$1 and v.campaign_id=$2 order by v.number desc`, [ctx.clientId, campaignId]);
  return rows.map((r) => ({ ...r, roi: roi(r.investment, r.turnover) }));
}

export async function getVersion(ctx: Ctx, campaignId: string, numberParam: string) {
  const c = await campaignFor(ctx.db, ctx, campaignId);
  const latest = (await ctx.db.query<{ n: number | null }>('select max(number) n from kam.offer_version where client_id=$1 and campaign_id=$2', [ctx.clientId, campaignId])).rows[0]!.n;
  if (!latest) throw notFound();
  const number = numberParam === 'current' ? latest : Number(numberParam);
  if (!Number.isInteger(number) || number < 1) throw notFound();
  const v = (await ctx.db.query<{ id: string; number: number; periods: Period[]; justification: string; comment: string; created_at: string; author: string }>(
    `select v.id, v.number, v.periods, v.justification, v.comment, v.created_at, u.display_name author
       from kam.offer_version v join kam.app_user u on u.id = v.created_by where v.client_id=$1 and v.campaign_id=$2 and v.number=$3`,
    [ctx.clientId, campaignId, number])).rows[0];
  if (!v) throw notFound();
  const cellsOf = async (versionId: string) => (await ctx.db.query<{ brand_id: string; name: string; period_key: string; investment: number; turnover: number }>(
    `select x.brand_id, b.name, x.period_key, x.investment::float8 investment, x.turnover::float8 turnover
       from kam.offer_version_cell x join kam.brand b on b.client_id = x.client_id and b.id = x.brand_id
      where x.client_id=$1 and x.version_id=$2 order by b.name`, [ctx.clientId, versionId])).rows;
  const cells = await cellsOf(v.id);
  const prev = number > 1 ? (await ctx.db.query<{ id: string }>('select id from kam.offer_version where client_id=$1 and campaign_id=$2 and number=$3', [ctx.clientId, campaignId, number - 1])).rows[0] : undefined;
  const prevCells = prev ? await cellsOf(prev.id) : [];
  const notes = new Map((await ctx.db.query<{ brand_id: string; note: string }>('select brand_id, note from kam.offer_version_brand_note where client_id=$1 and version_id=$2', [ctx.clientId, v.id])).rows.map((r) => [r.brand_id, r.note]));
  const { rows: documents } = await ctx.db.query(
    `select d.id, d.kind, d.file_name, d.archived_at from kam.offer_version_document vd join kam.document d on d.client_id = vd.client_id and d.id = vd.document_id
      where vd.client_id=$1 and vd.version_id=$2 order by d.file_name`, [ctx.clientId, v.id]);
  const prior = await priorFor(ctx.db, ctx.clientId, c.network_id, c.period_from, c.period_to);
  const t = await thresholds(ctx.db, ctx.clientId);
  const limit = await brandLimit(ctx.db, ctx, c.owner_id);
  const quarterly = v.periods.every((p) => /-Q[1-4]$/.test(p.key));

  // Строки брендов; при ограничении по брендам чужие бренды сворачиваются в одну строку «Прочие бренды».
  type Row = { brand_id: string | null; name: string; cells: Record<string, { investment: number; turnover: number }>; note: string | null; prior: PriorAgg | undefined; previous: { investment: number; turnover: number } | null };
  const rows = new Map<string, Row>();
  const keyOf = (brandId: string) => (limit && !limit.has(brandId) ? '__other' : brandId);
  for (const x of cells) {
    const k = keyOf(x.brand_id);
    if (!rows.has(k)) rows.set(k, { brand_id: k === '__other' ? null : x.brand_id, name: k === '__other' ? 'Прочие бренды' : x.name, cells: {}, note: k === '__other' ? null : notes.get(x.brand_id) ?? null, prior: undefined, previous: null });
    const r = rows.get(k)!;
    const cell = r.cells[x.period_key] ?? { investment: 0, turnover: 0 };
    cell.investment = money(cell.investment + x.investment);
    cell.turnover = money(cell.turnover + x.turnover);
    r.cells[x.period_key] = cell;
  }
  const priorByKey = new Map<string, PriorAgg>();
  for (const [brandId, agg] of prior.byBrand) {
    if (brandId === '*') continue;
    const k = keyOf(brandId);
    const cur = priorByKey.get(k) ?? { plan_investment: null, fact_investment: null, plan_turnover: null, fact_turnover: null };
    for (const f of ['plan_investment', 'fact_investment', 'plan_turnover', 'fact_turnover'] as const) if (agg[f] !== null) cur[f] = money((cur[f] ?? 0) + agg[f]!);
    priorByKey.set(k, cur);
  }
  const prevByKey = new Map<string, { investment: number; turnover: number }>();
  for (const x of prevCells) {
    const k = keyOf(x.brand_id);
    const cur = prevByKey.get(k) ?? { investment: 0, turnover: 0 };
    prevByKey.set(k, { investment: money(cur.investment + x.investment), turnover: money(cur.turnover + x.turnover) });
  }
  const brandRows = [...rows.entries()].map(([k, r]) => {
    const inv = money(Object.values(r.cells).reduce((a, x) => a + x.investment, 0));
    const turn = money(Object.values(r.cells).reduce((a, x) => a + x.turnover, 0));
    const pv = priorView(priorByKey.get(k));
    const periodPrior = quarterly && k !== '__other'
      ? Object.fromEntries(v.periods.map((p) => [p.key, priorView(prior.byBrandQuarter.get(`${k}|${p.key}`))]))
      : null;
    return {
      brand_id: r.brand_id, name: r.name, note: r.note, cells: r.cells,
      total: { investment: inv, turnover: turn, roi: roi(inv, turn) },
      previous: prevByKey.get(k) ?? null,
      prior: pv, period_prior: periodPrior,
      highlights: k === '__other' ? [] : highlightsFor(t, { investment: inv, turnover: turn }, pv),
    };
  }).sort((a, b) => (a.brand_id === null ? 1 : b.brand_id === null ? -1 : b.total.investment - a.total.investment));
  const inv = money(cells.reduce((a, x) => a + x.investment, 0));
  const turn = money(cells.reduce((a, x) => a + x.turnover, 0));
  const totalPrior = priorView(prior.byBrand.get('*'));
  const prevTotal = prev ? { investment: money(prevCells.reduce((a, x) => a + x.investment, 0)), turnover: money(prevCells.reduce((a, x) => a + x.turnover, 0)) } : null;
  return {
    number: v.number, latest, created_at: v.created_at, author: v.author, periods: v.periods,
    justification: v.justification, comment: v.comment, documents,
    brands: brandRows,
    totals: { investment: inv, turnover: turn, roi: roi(inv, turn), previous: prevTotal, prior: totalPrior,
      highlights: highlightsFor(t, { investment: inv, turnover: turn }, totalPrior) },
    prior_label: prior.label, thresholds: t, brand_limited: Boolean(limit),
  };
}

/** Текущие периоды кампании и данные для редактора новой версии: последняя версия как основа. */
export async function versionDraft(ctx: Ctx, campaignId: string) {
  const c = await campaignFor(ctx.db, ctx, campaignId);
  const periods = campaignPeriods(c);
  const latest = (await ctx.db.query<{ id: string; number: number; justification: string }>('select id, number, justification from kam.offer_version where client_id=$1 and campaign_id=$2 order by number desc limit 1', [ctx.clientId, campaignId])).rows[0];
  const cells = latest ? (await ctx.db.query<{ brand_id: string; period_key: string; investment: number; turnover: number }>(
    'select brand_id, period_key, investment::float8 investment, turnover::float8 turnover from kam.offer_version_cell where client_id=$1 and version_id=$2', [ctx.clientId, latest.id])).rows
    .filter((x) => periods.some((p) => p.key === x.period_key)) : [];
  const prior = await priorFor(ctx.db, ctx.clientId, c.network_id, c.period_from, c.period_to);
  const priorBrands = Object.fromEntries([...prior.byBrand.entries()].filter(([k]) => k !== '*').map(([k, v]) => [k, priorView(v)]));
  return { periods, base_number: latest?.number ?? null, cells, justification: latest?.justification ?? '', prior: priorBrands, prior_label: prior.label, thresholds: await thresholds(ctx.db, ctx.clientId) };
}

/** Итоги версии и прошлого периода для условий маршрута (ТЗ §5). */
export async function versionMetrics(q: Q, clientId: string, c: { network_id: string; period_from: string; period_to: string }, versionId: string) {
  const v = (await q.query<{ number: number; investment: number; turnover: number; justification: string }>(
    'select number, total_investment::float8 investment, total_turnover::float8 turnover, justification from kam.offer_version where client_id=$1 and id=$2', [clientId, versionId])).rows[0];
  if (!v) throw notFound();
  const { rows } = await q.query<{ brand_id: string }>(
    'select distinct brand_id from kam.offer_version_cell where client_id=$1 and version_id=$2 and (investment > 0 or turnover > 0)', [clientId, versionId]);
  const prior = priorView((await priorFor(q, clientId, c.network_id, c.period_from, c.period_to)).byBrand.get('*'));
  return {
    number: v.number, investment: v.investment, turnover: v.turnover, roi: roi(v.investment, v.turnover), justification: v.justification,
    brand_ids: rows.map((r) => r.brand_id),
    prior_fact_investment: prior?.fact_investment ?? null, prior_fact_roi: prior?.fact_roi ?? null,
  };
}
export type VersionMetrics = Awaited<ReturnType<typeof versionMetrics>>;
