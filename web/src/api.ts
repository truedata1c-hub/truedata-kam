// Клиент API модуля: сессия в cookie, Idempotency-Key на каждую команду, If-Match для кампании.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field: string | null = null, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface ApiResponse<T> { data: T; etag?: string }
interface Options { body?: unknown; ifMatch?: string; query?: Record<string, string | number | undefined | null> }

const BASE = '/api/kam/v1';
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function request<T>(method: string, path: string, o: Options = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  if (o.ifMatch) headers['if-match'] = o.ifMatch;
  const qs = o.query
    ? '?' + new URLSearchParams(Object.entries(o.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : '';
  let res: Response;
  try {
    res = await fetch(BASE + path + qs, { method, headers, credentials: 'same-origin', body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте подключение и повторите.');
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ответ прокси не в JSON */ }
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? 'Ошибка сервера.', e.field ?? null, e.details ?? {});
  }
  return { data: json as T, etag: res.headers.get('etag') ?? undefined };
}

export const api = {
  get: <T>(path: string, query?: Options['query']) => request<T>('GET', path, { query }).then((r) => r.data),
  getWithEtag: <T>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}, ifMatch?: string) => request<T>('POST', path, { body, ifMatch }),
  put: <T = any>(path: string, body: unknown = {}) => request<T>('PUT', path, { body }),
  patch: <T = any>(path: string, body: unknown, ifMatch?: string) => request<T>('PATCH', path, { body, ifMatch }),
};
