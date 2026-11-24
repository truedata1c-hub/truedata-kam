// Часовой пояс модуля: «сегодня», сроки шагов, просрочки, замещения и закрепления считаются по нему,
// а не по часовому поясу сервера (контейнеры работают в UTC). По умолчанию — Москва.

const DEFAULT_TZ = 'Europe/Moscow';

function zone(v: string | undefined): string {
  const tz = (v ?? '').trim() || DEFAULT_TZ;
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) throw new Error(`APP_TIMEZONE: некорректный часовой пояс «${tz}»`);
  // Неизвестный пояс Intl отклоняет сразу — ошибка конфигурации видна при запуске, а не в отчётах.
  new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  return tz;
}

export const APP_TZ = zone(process.env.APP_TIMEZONE);

/** Сегодняшняя дата ГГГГ-ММ-ДД в часовом поясе модуля. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
