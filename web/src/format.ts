export const STAGES = ['PREPARATION', 'NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL'] as const;
export const STAGE_LABEL: Record<string, string> = {
  PREPARATION: 'Подготовка', NEGOTIATION: 'Переговоры с сетью', APPROVAL: 'Внутреннее согласование', APPROVED: 'Согласовано внутри',
  CONFIRMED: 'Подтверждено сетью', FINAL: 'Финальные условия', CANCELLED: 'Отменена', CLOSED: 'Закрыта',
};
export const STAGE_SHORT: Record<string, string> = {
  PREPARATION: 'Подготовка', NEGOTIATION: 'Переговоры', APPROVAL: 'Согласование', APPROVED: 'Согласовано', CONFIRMED: 'Подтверждено', FINAL: 'Финал', CANCELLED: 'Отменена', CLOSED: 'Закрыта',
};
export const STAGE_TONE: Record<string, string> = {
  PREPARATION: 'gray', NEGOTIATION: 'purple', APPROVAL: 'amber', APPROVED: 'green', CONFIRMED: 'green', FINAL: 'green', CANCELLED: 'red', CLOSED: '',
};
export const SPLIT_LABEL: Record<string, string> = { MONTH: 'По месяцам', QUARTER: 'По кварталам', FOUR_MONTHS: 'По четыре месяца', WHOLE: 'Весь период' };
export const PERMISSION_LABEL: Record<string, string> = {
  CAMPAIGN_EDIT: 'Вести кампании', CAMPAIGN_EDIT_SUBORDINATES: 'Вести кампании подчинённых', APPROVE: 'Согласовывать', ANALYTICS: 'Смотреть аналитику', ADMIN: 'Администрировать',
};
export const PERMISSION_HINT: Record<string, string> = {
  CAMPAIGN_EDIT: 'Создавать кампании, загружать документы и версии, отправлять на согласование.',
  CAMPAIGN_EDIT_SUBORDINATES: 'То же за сотрудников ниже по оргструктуре.',
  APPROVE: 'Быть исполнителем шага маршрута согласования.',
  ANALYTICS: 'Экран «Аналитика» в своей области видимости.',
  ADMIN: 'Пользователи, роли, оргструктура, сети, бренды, маршруты и настройки.',
};
export const SCOPE_LABEL: Record<string, string> = { OWN: 'Свои сети', SUBORDINATES: 'Сети подчинённых', ALL: 'Все сети', BRANDS: 'Свои бренды' };
export const SCOPE_HINT: Record<string, string> = {
  OWN: 'Кампании сетей, за которыми закреплён сотрудник.',
  SUBORDINATES: 'Свои сети и сети всех сотрудников ниже по оргструктуре.',
  ALL: 'Все кампании клиента.',
  BRANDS: 'Все кампании; суммы — по назначенным брендам, остальное итогом (с шага 2).',
};

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('ru-RU') : '—');
export const fmtTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtPeriod = (a: string, b: string) => `${fmtDate(a)} – ${fmtDate(b)}`;
export const campaignNo = (n: number) => `К-${String(n).padStart(4, '0')}`;
export const initials = (name: string) => {
  const n = name.trim().split(/\s+/).filter(Boolean);
  return ((n[0]?.[0] ?? '') + (n[1]?.[0] ?? '')).toUpperCase() || '?';
};
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

// Суммы: в таблицах — тыс. ₽ без лишних знаков, в карточках — сокращённо (млн / тыс.), в подсказках — полностью.
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtRub = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf2.format(v)} ₽`);
export const fmtShort = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${nf1.format(v / 1e9)} млрд ₽`;
  if (a >= 1e6) return `${nf1.format(v / 1e6)} млн ₽`;
  if (a >= 1e3) return `${nf0.format(v / 1e3)} тыс. ₽`;
  return `${nf0.format(v)} ₽`;
};
export const fmtThousands = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf0.format(v / 1000));
export const fmtRoi = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf1.format(v)}×`);
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf1.format(v)} %`);
export const deltaPct = (cur: number, base: number | null | undefined) => (base ? ((cur - base) / base) * 100 : null);
export const fmtDelta = (v: number | null) => (v === null ? '' : `${v > 0 ? '+' : ''}${nf1.format(v)} %`);
export const fmtSize = (b: number) => (b >= 1048576 ? `${nf1.format(b / 1048576)} МБ` : `${nf0.format(Math.max(1, b / 1024))} КБ`);

export const HIGHLIGHT: Record<string, { label: string; short: string; tone: string; hint: string }> = {
  INVESTMENT_GROWTH: { label: 'Рост инвестиций', short: 'Рост инв.', tone: 'amber', hint: 'Инвестиции выше факта прошлого периода больше порога из настроек.' },
  INVESTMENT_NEW: { label: 'Новые инвестиции', short: 'Новые инв.', tone: 'amber', hint: 'В прошлом периоде фактических инвестиций по бренду не было.' },
  ROI_BELOW_PRIOR: { label: 'ROI ниже прошлого', short: 'ROI ↓', tone: 'amber', hint: 'Оборот на рубль инвестиций ниже факта прошлого периода.' },
  PRIOR_UNDERPERFORMED: { label: 'План прошлого не выполнен', short: 'План не вып.', tone: 'red', hint: 'Выполнение плана оборота прошлого периода ниже порога.' },
  NO_PRIOR: { label: 'Нет прошлого периода', short: 'Нет факта', tone: 'gray', hint: 'По бренду в сети нет плана и факта прошлого периода.' },
};

export const DOC_KIND: Record<string, string> = {
  OUR_OFFER: 'Наше предложение', NETWORK_OFFER: 'Встречное предложение сети', MEETING_MINUTES: 'Протокол встречи', CALCULATION: 'Расчёт',
  NETWORK_CONFIRMATION: 'Подтверждение сети', SIGNED_CONTRACT: 'Подписанный договор', FINAL_TERMS: 'Финальные условия', OTHER: 'Прочее',
};
