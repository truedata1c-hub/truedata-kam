/** Ошибка API: код, сообщение для пользователя, поле формы и подробности. Формат как в MDM. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly field: string | null = null,
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Ресурс отсутствует или недоступен.');
export const forbidden = (message = 'В вашей роли это действие недоступно.') => new ApiError(403, 'FORBIDDEN', message);
export const required = (field: string, message = 'Заполните обязательное поле.') =>
  new ApiError(422, 'FIELD_REQUIRED', message, {}, field);
export const invalid = (field: string, message: string, code = 'INVALID_FIELD') => new ApiError(422, code, message, {}, field);

/** Ошибки ограничений PostgreSQL, которые означают нарушение правил данных, а не сбой. */
export function fromPg(e: unknown): ApiError | null {
  const err = e as { code?: string; constraint?: string; table?: string };
  if (err?.code === '23P01') {
    if (err.table === 'user_manager') return new ApiError(422, 'PERIOD_OVERLAP', 'У сотрудника уже есть руководитель на эти даты.');
    if (err.table === 'kam_assignment') return new ApiError(422, 'PERIOD_OVERLAP', 'У сети уже есть закрепление на эти даты. Обновите список сотрудников.', {}, 'network_id');
    return new ApiError(422, 'PERIOD_OVERLAP', 'Периоды действия пересекаются.', { table: err.table });
  }
  if (err?.code === '23505') {
    const c = err.constraint ?? '';
    if (c.includes('inn')) return new ApiError(422, 'DUPLICATE', 'Юрлицо с таким ИНН уже есть.', {}, 'inn');
    if (c.includes('name')) return new ApiError(422, 'DUPLICATE', 'Запись с таким названием уже есть.', {}, 'name');
    return new ApiError(422, 'DUPLICATE', 'Такая запись уже есть.', { constraint: c });
  }
  if (err?.code === '23503') return new ApiError(422, 'INVALID_REFERENCE', 'Ссылка на несуществующую запись.', { constraint: err.constraint });
  if (err?.code === '23514') return new ApiError(422, 'INVALID_FIELD', 'Значение не проходит проверку.', { constraint: err.constraint });
  if (err?.code === '22007' || err?.code === '22008') return new ApiError(422, 'INVALID_FIELD', 'Некорректная дата.');
  return null;
}
