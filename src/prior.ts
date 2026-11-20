// Прошлые периоды (ТЗ §6.3): план и факт по сети × бренду × кварталу. Этап 1 — загрузка администратором из Excel;
// этап 2 — автоматически из PharmaCheck по ИНН сети. Загрузка заменяет данные выбранного года целиком.

import { todayIso } from './time.js';
import type { FastifyRequest } from 'fastify';
import type { Tx } from './db.js';
import { withTx } from './db.js';
import { ApiError, invalid, required } from './errors.js';
import { type Ctx, requirePermission } from './access.js';
import { type CommandResult, audit } from './commands.js';
import { parsePrior, priorTemplate, type ParseIssue } from './excel.js';

const yearOf = (v: unknown) => {
  const y = Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw invalid('year', 'Укажите год.');
  return y;
};

export async function summary(ctx: Ctx, year: unknown) {
  requirePermission(ctx, 'ADMIN');
  const { rows: years } = await ctx.db.query<{ year: number; rows: number; loaded_at: string }>(
    'select year, count(*)::int rows, max(loaded_at) loaded_at from kam.prior_period where client_id=$1 group by year order by year desc', [ctx.clientId]);
  const y = year === undefined || year === '' ? years[0]?.year ?? Number(todayIso().slice(0, 4)) - 1 : yearOf(year);
  const { rows } = await ctx.db.query(
    `select n.id network_id, n.name network, count(distinct p.brand_id)::int brands,
            sum(p.plan_investment)::float8 plan_investment, sum(p.fact_investment)::float8 fact_investment,
            sum(p.plan_turnover)::float8 plan_turnover, sum(p.fact_turnover)::float8 fact_turnover
       from kam.prior_period p join kam.network n on n.client_id = p.client_id and n.id = p.network_id
      where p.client_id=$1 and p.year=$2 group by n.id, n.name order by n.name`, [ctx.clientId, y]);
  return { year: y, years, networks: rows };
}

export async function template(ctx: Ctx, year: unknown): Promise<Buffer> {
  requirePermission(ctx, 'ADMIN');
  const y = yearOf(year);
  const { rows } = await ctx.db.query(
    `select n.name network, b.name brand, p.year, p.quarter, p.plan_investment::float8 plan_investment, p.fact_investment::float8 fact_investment,
            p.plan_turnover::float8 plan_turnover, p.fact_turnover::float8 fact_turnover
       from kam.prior_period p join kam.network n on n.client_id = p.client_id and n.id = p.network_id
       join kam.brand b on b.client_id = p.client_id and b.id = p.brand_id
      where p.client_id=$1 and p.year=$2 order by n.name, b.name, p.quarter`, [ctx.clientId, y]);
  const networks = (await ctx.db.query<{ name: string }>('select name from kam.network where client_id=$1 and not archived order by name', [ctx.clientId])).rows.map((r) => r.name);
  const brands = (await ctx.db.query<{ name: string }>('select name from kam.brand where client_id=$1 and not archived order by name', [ctx.clientId])).rows.map((r) => r.name);
  return priorTemplate({ year: y, rows, networks, brands });
}

/** Загрузка всё-или-ничего: при любой ошибке данные не меняются и возвращается список ошибок по строкам. */
export async function importFile(ctx: Ctx, req: FastifyRequest): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!req.isMultipart()) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Передайте файл формой multipart/form-data.');
  const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3 } });
  if (!part) throw required('file', 'Выберите файл.');
  const year = yearOf((part.fields.year as { value?: unknown } | undefined)?.value);
  const buf = await part.toBuffer();
  if (part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', 'Файл больше 10 МБ.', {}, 'file');
  const { rows, issues } = await parsePrior(buf);
  const nets = new Map((await ctx.db.query<{ id: string; name: string }>('select id, name from kam.network where client_id=$1', [ctx.clientId])).rows.map((r) => [r.name.toLowerCase(), r.id]));
  const brands = new Map((await ctx.db.query<{ id: string; name: string }>('select id, name from kam.brand where client_id=$1', [ctx.clientId])).rows.map((r) => [r.name.toLowerCase(), r.id]));
  const seen = new Set<string>();
  const ready: { network_id: string; brand_id: string; quarter: number; vals: (number | null)[] }[] = [];
  for (const r of rows) {
    const n = nets.get(r.network.toLowerCase());
    const b = brands.get(r.brand.toLowerCase());
    if (r.network && !n) issues.push({ row: r.row, column: 'A', message: `Сеть «${r.network}» не найдена.` });
    if (r.brand && !b) issues.push({ row: r.row, column: 'B', message: `Бренд «${r.brand}» не найден.` });
    if (Number.isInteger(r.year) && r.year !== year) issues.push({ row: r.row, column: 'C', message: `Год ${r.year} не совпадает с выбранным (${year}).` });
    if (!n || !b) continue;
    const k = `${n}|${b}|${r.quarter}`;
    if (seen.has(k)) issues.push({ row: r.row, column: '', message: 'Повтор: эта сеть, бренд и квартал уже есть выше.' });
    seen.add(k);
    ready.push({ network_id: n, brand_id: b, quarter: r.quarter, vals: [r.plan_investment, r.fact_investment, r.plan_turnover, r.fact_turnover] });
  }
  if (issues.length) return { status: 422, body: { error: { code: 'IMPORT_ERRORS', message: `Найдено ошибок: ${issues.length}. Данные не изменены.`, field: 'file', details: { issues: issues.slice(0, 200) as ParseIssue[] } } } };
  if (!ready.length) throw invalid('file', 'В файле нет строк с данными.', 'EMPTY_IMPORT');
  return withTx(ctx.db, async (tx: Tx) => {
    const before = (await tx.query<{ n: number }>('select count(*)::int n from kam.prior_period where client_id=$1 and year=$2', [ctx.clientId, year])).rows[0]!.n;
    await tx.query('delete from kam.prior_period where client_id=$1 and year=$2', [ctx.clientId, year]);
    await tx.query(
      `insert into kam.prior_period(client_id, network_id, brand_id, year, quarter, plan_investment, fact_investment, plan_turnover, fact_turnover, loaded_by)
       select $1, x.network_id, x.brand_id, $2, x.quarter, x.v[1], x.v[2], x.v[3], x.v[4], $3
         from jsonb_to_recordset($4::jsonb) as x(network_id uuid, brand_id uuid, quarter int, v numeric[])`,
      [ctx.clientId, year, ctx.principal.userId, JSON.stringify(ready.map((r) => ({ network_id: r.network_id, brand_id: r.brand_id, quarter: r.quarter, v: r.vals })))]);
    await audit(tx, ctx, { entityType: 'prior_period', action: 'IMPORT', before: { year, rows: before }, after: { year, rows: ready.length } });
    return { status: 200, body: { year, rows: ready.length, replaced: before } };
  });
}
