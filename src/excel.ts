// Шаблоны Excel модуля со строгой структурой (ТЗ §6.2, §6.3): разбивка версии и прошлые периоды.
// Это не разбор произвольных документов: модуль читает только свои шаблоны и сообщает ошибки по ячейкам.

import ExcelJS from 'exceljs';
import type { Period } from './periods.js';

const HEAD = { font: { bold: true, color: { argb: 'FF344054' } }, fill: { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFF2F4F7' } } };
const MONEY = '#,##0.00';

export interface CellOut { brand_id: string; period_key: string; investment: number; turnover: number }
export interface ParseIssue { row: number; column: string; message: string }

function num(v: ExcelJS.CellValue): number | null | 'bad' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v && 'result' in v) return num((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  if (typeof v === 'string') {
    const s = v.replace(/[\s ₽]/g, '').replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : 'bad';
  }
  return 'bad';
}

const text = (v: ExcelJS.CellValue) => (v === null || v === undefined ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v)).trim();

// Разбивка версии ----------------------------------------------------------

/**
 * Лист «Разбивка»: строка 1 — служебные ключи (скрыта), строка 2 — заголовки. Столбец A — служебный id бренда (скрыт),
 * B — бренд, затем по каждому периоду два столбца: инвестиции и ожидаемый оборот.
 */
export async function versionTemplate(o: { title: string; periods: Period[]; brands: { id: string; name: string }[]; cells: CellOut[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PharmaCheck · Переговоры';
  const ws = wb.addWorksheet('Разбивка', { views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }] });
  const keys = ['brand_id', 'brand', ...o.periods.flatMap((p) => [`inv:${p.key}`, `turn:${p.key}`])];
  ws.addRow(keys);
  ws.addRow(['', 'Бренд', ...o.periods.flatMap((p) => [`${p.label} · инвестиции, ₽`, `${p.label} · оборот, ₽`])]);
  ws.getRow(1).hidden = true;
  ws.getRow(2).eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; c.alignment = { wrapText: true, vertical: 'middle' }; });
  ws.getRow(2).height = 32;
  ws.getColumn(1).hidden = true;
  ws.getColumn(2).width = 28;
  for (let i = 3; i <= keys.length; i++) { ws.getColumn(i).width = 18; ws.getColumn(i).numFmt = MONEY; }
  const byKey = new Map(o.cells.map((c) => [`${c.brand_id}|${c.period_key}`, c]));
  for (const b of o.brands) {
    ws.addRow([b.id, b.name, ...o.periods.flatMap((p) => {
      const c = byKey.get(`${b.id}|${p.key}`);
      return [c?.investment || null, c?.turnover || null];
    })]);
  }
  const info = wb.addWorksheet('Как заполнять');
  info.getColumn(1).width = 100;
  for (const line of [
    o.title,
    '',
    'Заполните суммы инвестиций и ожидаемого оборота в рублях на листе «Разбивка». Пустая ячейка — ноль.',
    'Бренды без сумм в версию не попадут. Не меняйте скрытые строку 1 и столбец A, не переименовывайте и не переставляйте столбцы.',
    'Загрузите файл в окне новой версии кнопкой «Загрузить из Excel» — проверьте значения и сохраните версию.',
  ]) info.addRow([line]);
  info.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseVersion(buf: Buffer, periods: Period[], brands: { id: string; name: string }[]): Promise<{ cells: CellOut[]; issues: ParseIssue[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { return { cells: [], issues: [{ row: 0, column: '', message: 'Файл не читается как Excel (.xlsx).' }] }; }
  const ws = wb.getWorksheet('Разбивка') ?? wb.worksheets[0];
  if (!ws) return { cells: [], issues: [{ row: 0, column: '', message: 'В файле нет листа «Разбивка».' }] };
  const issues: ParseIssue[] = [];
  const keyRow = ws.getRow(1);
  const cols = new Map<number, { kind: 'investment' | 'turnover'; period: string }>();
  const known = new Set(periods.map((p) => p.key));
  keyRow.eachCell((c, col) => {
    const m = /^(inv|turn):(.+)$/.exec(text(c.value));
    if (m && known.has(m[2]!)) cols.set(col, { kind: m[1] === 'inv' ? 'investment' : 'turnover', period: m[2]! });
  });
  if (!cols.size) return { cells: [], issues: [{ row: 1, column: '', message: 'Это не шаблон этой кампании: не найдены служебные ключи периодов. Скачайте шаблон заново.' }] };
  const missing = periods.filter((p) => ![...cols.values()].some((c) => c.period === p.key));
  if (missing.length) issues.push({ row: 1, column: '', message: `В файле нет периодов: ${missing.map((p) => p.label).join(', ')}. Шаблон устарел — скачайте его заново.` });
  const byId = new Map(brands.map((b) => [b.id, b]));
  const byName = new Map(brands.map((b) => [b.name.toLowerCase(), b]));
  const cells = new Map<string, CellOut>();
  ws.eachRow((row, r) => {
    if (r < 3) return;
    const id = text(row.getCell(1).value);
    const name = text(row.getCell(2).value);
    if (!id && !name) return;
    const brand = byId.get(id) ?? byName.get(name.toLowerCase());
    let any = false;
    const vals: { kind: 'investment' | 'turnover'; period: string; v: number }[] = [];
    for (const [col, meta] of cols) {
      const cell = row.getCell(col);
      const v = num(cell.value);
      if (v === 'bad' || (typeof v === 'number' && (v < 0 || v > 1e12))) {
        issues.push({ row: r, column: cell.address.replace(/\d+$/, ''), message: `Не число или отрицательное значение: «${text(cell.value)}».` });
        continue;
      }
      if (v) { any = true; vals.push({ ...meta, v }); }
    }
    if (!any) return;
    if (!brand) { issues.push({ row: r, column: 'B', message: `Бренд «${name}» не найден в справочнике.` }); return; }
    for (const x of vals) {
      const k = `${brand.id}|${x.period}`;
      const c = cells.get(k) ?? { brand_id: brand.id, period_key: x.period, investment: 0, turnover: 0 };
      c[x.kind] = Math.round(x.v * 100) / 100;
      cells.set(k, c);
    }
  });
  return { cells: [...cells.values()], issues };
}

// Прошлые периоды ----------------------------------------------------------

export const PRIOR_COLUMNS = ['Сеть', 'Бренд', 'Год', 'Квартал', 'План инвестиций, ₽', 'Факт инвестиций, ₽', 'План оборота, ₽', 'Факт оборота, ₽'];

export interface PriorRowOut { network: string; brand: string; year: number; quarter: number; plan_investment: number | null; fact_investment: number | null; plan_turnover: number | null; fact_turnover: number | null; row: number }

export async function priorTemplate(o: { year: number; rows: Omit<PriorRowOut, 'row'>[]; networks: string[]; brands: string[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Прошлый период', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(PRIOR_COLUMNS);
  ws.getRow(1).eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; });
  [26, 22, 8, 10, 20, 20, 20, 20].forEach((w, i) => { ws.getColumn(i + 1).width = w; if (i >= 4) ws.getColumn(i + 1).numFmt = MONEY; });
  for (const r of o.rows) ws.addRow([r.network, r.brand, r.year, r.quarter, r.plan_investment, r.fact_investment, r.plan_turnover, r.fact_turnover]);
  const ref = wb.addWorksheet('Справочники');
  ref.addRow(['Сети', 'Бренды']);
  ref.getRow(1).font = { bold: true };
  for (let i = 0; i < Math.max(o.networks.length, o.brands.length); i++) ref.addRow([o.networks[i] ?? null, o.brands[i] ?? null]);
  ref.getColumn(1).width = 30;
  ref.getColumn(2).width = 30;
  const info = wb.addWorksheet('Как заполнять');
  info.getColumn(1).width = 100;
  for (const line of [
    `План и факт ${o.year} года по сети, бренду и кварталу`,
    '',
    'Одна строка — сеть × бренд × квартал. Названия сетей и брендов — как на листе «Справочники».',
    'Суммы в рублях; пустая ячейка — данных нет. Загрузка заменяет все данные выбранного года.',
  ]) info.addRow([line]);
  info.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parsePrior(buf: Buffer): Promise<{ rows: PriorRowOut[]; issues: ParseIssue[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { return { rows: [], issues: [{ row: 0, column: '', message: 'Файл не читается как Excel (.xlsx).' }] }; }
  const ws = wb.getWorksheet('Прошлый период') ?? wb.worksheets[0];
  if (!ws) return { rows: [], issues: [{ row: 0, column: '', message: 'В файле нет листа «Прошлый период».' }] };
  const head = PRIOR_COLUMNS.map((_, i) => text(ws.getRow(1).getCell(i + 1).value).toLowerCase());
  if (head[0] !== 'сеть' || head[1] !== 'бренд' || head[2] !== 'год' || head[3] !== 'квартал') {
    return { rows: [], issues: [{ row: 1, column: '', message: 'Первая строка должна содержать столбцы: ' + PRIOR_COLUMNS.join(', ') + '.' }] };
  }
  const rows: PriorRowOut[] = [];
  const issues: ParseIssue[] = [];
  ws.eachRow((row, r) => {
    if (r < 2) return;
    const network = text(row.getCell(1).value);
    const brand = text(row.getCell(2).value);
    if (!network && !brand) return;
    const year = num(row.getCell(3).value);
    const quarter = num(row.getCell(4).value);
    if (!network) issues.push({ row: r, column: 'A', message: 'Не указана сеть.' });
    if (!brand) issues.push({ row: r, column: 'B', message: 'Не указан бренд.' });
    if (typeof year !== 'number' || !Number.isInteger(year)) issues.push({ row: r, column: 'C', message: 'Год — целое число.' });
    if (typeof quarter !== 'number' || ![1, 2, 3, 4].includes(quarter)) issues.push({ row: r, column: 'D', message: 'Квартал — 1, 2, 3 или 4.' });
    const vals: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const v = num(row.getCell(5 + i).value);
      if (v === 'bad' || (typeof v === 'number' && v < 0)) { issues.push({ row: r, column: String.fromCharCode(69 + i), message: 'Сумма — неотрицательное число.' }); vals.push(null); }
      else vals.push(v === null ? null : Math.round(v * 100) / 100);
    }
    rows.push({ network, brand, year: Number(year), quarter: Number(quarter), plan_investment: vals[0]!, fact_investment: vals[1]!, plan_turnover: vals[2]!, fact_turnover: vals[3]!, row: r });
  });
  return { rows, issues };
}
