// Очистка служебных таблиц: без неё сессии, ключи идемпотентности, уведомления и журнал писем растут бесконечно.
// Журнал изменений (audit_event), история кампаний, версии и документы не чистятся никогда.

import type { Db } from './db.js';

export const RETENTION = {
  /** Истёкшие сессии хранятся сутки — для разбора входа. */
  sessionDays: 1,
  /** Повтор команды с тем же ключом возможен месяц. */
  idempotencyDays: 30,
  loginAttemptDays: 1,
  ssoTokenDays: 1,
  /** Прочитанные уведомления — полгода, непрочитанные — год. */
  readNotificationDays: 180,
  unreadNotificationDays: 365,
  /** Завершённые письма (отправлено, не доставлено, устарело) — полгода. */
  finishedEmailDays: 180,
};

export interface HousekeepingResult { sessions: number; idempotency: number; loginAttempts: number; ssoTokens: number; notifications: number; emails: number }

export async function housekeeping(db: Pick<Db, 'query'>): Promise<HousekeepingResult> {
  const del = async (sql: string, days: number) => (await db.query(sql, [days])).rowCount ?? 0;
  const r = RETENTION;
  return {
    sessions: await del('delete from kam.session where expires_at < now() - make_interval(days => $1)', r.sessionDays),
    idempotency: await del('delete from kam.idempotency_request where created_at < now() - make_interval(days => $1)', r.idempotencyDays),
    loginAttempts: await del('delete from kam.login_attempt where at < now() - make_interval(days => $1)', r.loginAttemptDays),
    ssoTokens: await del('delete from kam.sso_token_use where expires_at < now() - make_interval(days => $1)', r.ssoTokenDays),
    notifications: (await db.query(
      `delete from kam.notification where (read_at is not null and created_at < now() - make_interval(days => $1))
          or created_at < now() - make_interval(days => $2)`, [r.readNotificationDays, r.unreadNotificationDays])).rowCount ?? 0,
    emails: await del(`delete from kam.email_outbox where status in ('SENT','FAILED','EXPIRED') and created_at < now() - make_interval(days => $1)`, r.finishedEmailDays),
  };
}
