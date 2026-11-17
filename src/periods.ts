// Периоды разбивки версии (ТЗ §6.2): деление периода кампании по типу — месяцы, кварталы, четыре месяца или весь период.
// Граничные периоды обрезаются датами кампании. Ключи стабильны: 2027-Q1, 2027-M03, 2027-T2, ALL.

export type Split = 'MONTH' | 'QUARTER' | 'FOUR_MONTHS' | 'WHOLE';
export interface Period { key: string; label: string; from: string; to: string }

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ROMAN = ['I', 'II', 'III', 'IV'];

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function periodsFor(split: Split, from: string, to: string): Period[] {
  if (split === 'WHOLE') return [{ key: 'ALL', label: 'Весь период', from, to }];
  const size = split === 'MONTH' ? 1 : split === 'QUARTER' ? 3 : 4;
  const out: Period[] = [];
  let y = Number(from.slice(0, 4));
  let m = Math.floor((Number(from.slice(5, 7)) - 1) / size) * size;
  for (let guard = 0; guard < 400; guard++) {
    const start = iso(y, m, 1);
    if (start > to) break;
    const endM = m + size - 1;
    const end = iso(y, endM, lastDay(y, endM));
    const idx = m / size;
    const key = split === 'MONTH' ? `${y}-M${String(m + 1).padStart(2, '0')}` : split === 'QUARTER' ? `${y}-Q${idx + 1}` : `${y}-T${idx + 1}`;
    const label = split === 'MONTH' ? `${MONTHS[m]} ${y}` : split === 'QUARTER' ? `${ROMAN[idx]} кв. ${y}` : `${MONTHS[m]}–${MONTHS[endM]} ${y}`;
    out.push({ key, label, from: start < from ? from : start, to: end > to ? to : end });
    m += size;
    if (m >= 12) { m = 0; y += 1; }
  }
  return out;
}

/** Кварталы календаря, которые пересекает период (для сопоставления с прошлыми периодами). */
export function quartersOf(from: string, to: string): { year: number; quarter: number }[] {
  return periodsFor('QUARTER', from, to).map((p) => ({ year: Number(p.key.slice(0, 4)), quarter: Number(p.key.slice(6)) }));
}

/** Сдвиг даты на год назад (29 февраля → 28 февраля). */
export function yearBack(d: string): string {
  const y = Number(d.slice(0, 4)) - 1;
  const m = Number(d.slice(5, 7)) - 1;
  const day = Math.min(Number(d.slice(8, 10)), lastDay(y, m));
  return iso(y, m, day);
}
