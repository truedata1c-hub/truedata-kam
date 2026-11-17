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
