// Уведомления (ТЗ §8.1): центр уведомлений в системе и почтовый канал с очередью, повтором и журналом.
// Пока почтовый сервер не подключён, письма копятся со статусом «канал не настроен» и отправляются после подключения.

import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Db, Tx } from './db.js';
import { withTx } from './db.js';
import { invalid } from './errors.js';
import { type Ctx, requirePermission } from './access.js';
import { type CommandResult, audit, isUuid, lockCampaignRecord } from './commands.js';
import { readSettings, writeSetting } from './settings.js';
import { openSecret, sealSecret } from './secrets.js';

type Q = Pick<Tx, 'query'>;

/** Каталог событий: подпись для настроек и письмо по умолчанию. */
export const KINDS = {
  STEP_ASSIGNED: { label: 'Новый шаг согласования для меня', email: true },
  STEP_REMINDER: { label: 'Напоминание: срок шага сегодня', email: true },
  STEP_OVERDUE: { label: 'Просрочен шаг согласования (мой или подчинённого)', email: true },
  DECISION: { label: 'Решение по моей кампании', email: false },
  APPROVED: { label: 'Кампания согласована внутри', email: true },
  RETURNED: { label: 'Кампания возвращена на доработку', email: true },
  VERSION_CHANGED: { label: 'Новая версия согласованной мной кампании', email: false },
  CONTROL_OVERDUE: { label: 'Просрочена контрольная дата кампании', email: true },
  MENTION: { label: 'Упоминание в переписке', email: true },
  CONFIRMED: { label: 'Сеть подтвердила условия', email: false },
} as const;
export type Kind = keyof typeof KINDS;

export interface NotifyInput { kind: Kind; users: (string | null | undefined)[]; campaignId?: string | null; title: string; body?: string; actorId?: string | null }

export interface SmtpSettings { host: string; port: number; secure: boolean; user: string; password: string; from: string }

/** Срок актуальности письма, накопленного без почтового канала: старше — не отправляется задним числом. */
export const BACKLOG_HOURS = 72;

/** Настроенный канал с расшифрованным паролем. Пароль зашифрован другим ключом или без ключа — канал считается ненастроенным. */
async function smtpOf(q: Q, clientId: string): Promise<SmtpSettings | null> {
  const s = (await readSettings(q, clientId)).smtp as SmtpSettings | undefined;
  if (!s?.host || !s.from) return null;
  const password = openSecret(s.password ?? '');
  if (password === null) {
    console.error(`smtp: пароль клиента ${clientId} зашифрован, но SETTINGS_KEY не задан или не подходит — письма ждут`);
    return null;
  }
  return { ...s, password };
}

const appUrl = () => (process.env.APP_URL ?? '').replace(/\/$/, '');

/** Создаёт уведомления (кроме автора действия) и письма по настройкам получателей. Вызывается в транзакции команды. */
export async function notify(q: Q, clientId: string, n: NotifyInput): Promise<number> {
  const users = [...new Set(n.users.filter((u): u is string => Boolean(u) && u !== n.actorId))];
  if (!users.length) return 0;
  const { rows: people } = await q.query<{ id: string; email: string; pref: boolean | null }>(
    `select u.id, u.email, p.email pref from kam.app_user u
       join kam.membership m on m.client_id = $1 and m.user_id = u.id and m.active
       left join kam.notification_pref p on p.client_id = $1 and p.user_id = u.id and p.kind = $3
      where u.id = any($2::uuid[]) and not u.disabled`, [clientId, users, n.kind]);
  const channel = await smtpOf(q, clientId);
  const link = n.campaignId && appUrl() ? `${appUrl()}/#/campaign/${n.campaignId}` : '';
  for (const p of people) {
    const id = randomUUID();
    await q.query('insert into kam.notification(client_id, id, user_id, kind, campaign_id, title, body, actor_id) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [clientId, id, p.id, n.kind, n.campaignId ?? null, n.title.slice(0, 300), (n.body ?? '').slice(0, 2000), n.actorId ?? null]);
    if (p.pref ?? KINDS[n.kind].email) {
      const text = [n.title, n.body, link ? `Открыть: ${link}` : '', '', 'PharmaCheck · Переговоры. Настроить письма можно в центре уведомлений.'].filter((x) => x !== undefined).join('\n');
      await q.query(
        `insert into kam.email_outbox(client_id, id, notification_id, user_id, to_email, subject, body, status) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [clientId, randomUUID(), id, p.id, p.email, `PharmaCheck · ${n.title}`.slice(0, 250), text, channel ? 'QUEUED' : 'NO_CHANNEL']);
    }
  }
  return people.length;
}

// Центр уведомлений ---------------------------------------------------------------

export async function listNotifications(ctx: Ctx, q: { unread?: string }) {
  const { rows } = await ctx.db.query(
    `select n.id, n.kind, n.title, n.body, n.campaign_id, n.created_at, n.read_at, a.display_name actor_name
       from kam.notification n left join kam.employee_profile a on a.client_id = n.client_id and a.id = n.actor_id
      where n.client_id=$1 and n.user_id=$2 ${q.unread === '1' ? 'and n.read_at is null' : ''}
      order by n.created_at desc limit 50`, [ctx.clientId, ctx.principal.userId]);
  const unread = (await ctx.db.query<{ n: number }>('select count(*)::int n from kam.notification where client_id=$1 and user_id=$2 and read_at is null',
    [ctx.clientId, ctx.principal.userId])).rows[0]!.n;
  return { items: rows, unread };
}

export async function markRead(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  const all = b.all === true;
  const ids = Array.isArray(b.ids) ? b.ids.filter(isUuid) : [];
  if (!all && !ids.length) throw invalid('ids', 'Укажите уведомления.');
  const r = await tx.query(
    `update kam.notification set read_at = now() where client_id=$1 and user_id=$2 and read_at is null ${all ? '' : 'and id = any($3::uuid[])'}`,
    all ? [ctx.clientId, ctx.principal.userId] : [ctx.clientId, ctx.principal.userId, ids]);
  return { status: 200, body: { updated: r.rowCount } };
}

export async function getPrefs(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ kind: string; email: boolean }>('select kind, email from kam.notification_pref where client_id=$1 and user_id=$2', [ctx.clientId, ctx.principal.userId]);
  const saved = new Map(rows.map((r) => [r.kind, r.email]));
  const channel = await smtpOf(ctx.db, ctx.clientId);
  return {
    channel_configured: Boolean(channel), email: ctx.principal.email,
    items: (Object.keys(KINDS) as Kind[]).map((k) => ({ kind: k, label: KINDS[k].label, email: saved.get(k) ?? KINDS[k].email, default: KINDS[k].email })),
  };
}

export async function savePrefs(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  const prefs = b.email;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw invalid('email', 'Передайте настройки писем.');
  for (const [k, v] of Object.entries(prefs as Record<string, unknown>)) {
    if (!(k in KINDS) || typeof v !== 'boolean') throw invalid('email', 'Неизвестное событие.');
    await tx.query(`insert into kam.notification_pref(client_id, user_id, kind, email) values ($1,$2,$3,$4)
                    on conflict (client_id, user_id, kind) do update set email = excluded.email`, [ctx.clientId, ctx.principal.userId, k, v]);
  }
  return { status: 200, body: { ok: true } };
}

// Почтовый канал (администратор) ---------------------------------------------------

export async function getMailSettings(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const s = (await readSettings(ctx.db, ctx.clientId)).smtp as SmtpSettings | undefined;
  const { rows: stats } = await ctx.db.query<{ status: string; n: number }>('select status, count(*)::int n from kam.email_outbox where client_id=$1 group by status', [ctx.clientId]);
  const { rows: recent } = await ctx.db.query(
    `select o.id, o.to_email, o.subject, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, o.next_attempt_at
       from kam.email_outbox o where o.client_id=$1 order by o.created_at desc limit 100`, [ctx.clientId]);
  return {
    smtp: s ? { host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from, has_password: Boolean(s.password) } : null,
    stats: Object.fromEntries(stats.map((r) => [r.status, r.n])), recent,
  };
}

export async function saveMailSettings(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const before = (await readSettings(tx, ctx.clientId)).smtp as SmtpSettings | undefined;
  if (b.disabled === true) {
    await writeSetting(tx, ctx.clientId, 'smtp', null);
    await tx.query("update kam.email_outbox set status='NO_CHANNEL' where client_id=$1 and status in ('QUEUED','RETRY')", [ctx.clientId]);
    await audit(tx, ctx, { entityType: 'settings', action: 'UPDATE', after: { smtp: null } });
    return { status: 200, body: { configured: false } };
  }
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw invalid('host', 'Укажите адрес почтового сервера.');
  const port = Number(b.port ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('port', 'Порт — число от 1 до 65535.');
  const from = typeof b.from === 'string' ? b.from.trim() : '';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from) && !/^.{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(from)) throw invalid('from', 'Укажите адрес отправителя, например kam@company.ru.');
  const user = typeof b.user === 'string' ? b.user.trim().slice(0, 200) : '';
  // Пароль не возвращается в интерфейс; пустое поле при сохранении оставляет прежний.
  // Новый пароль шифруется ключом стенда (если задан); пустое поле оставляет сохранённое значение как есть.
  const password = typeof b.password === 'string' && b.password ? sealSecret(b.password.slice(0, 500)) : before?.password ?? '';
  const s: SmtpSettings = { host, port, secure: Boolean(b.secure), user, password, from };
  await writeSetting(tx, ctx.clientId, 'smtp', s);
  // Накопленные письма уходят в отправку, только если они ещё актуальны; старые помечаются устаревшими
  // (их можно отправить вручную из журнала писем), чтобы подключение почты не обрушило поток прошлых напоминаний.
  const { rows: [r] } = await tx.query<{ released: number; expired: number }>(
    `with u as (
       update kam.email_outbox set status = case when created_at > now() - make_interval(hours => $2) then 'QUEUED' else 'EXPIRED' end, next_attempt_at = now()
        where client_id=$1 and status='NO_CHANNEL' returning status)
     select count(*) filter (where status='QUEUED')::int released, count(*) filter (where status='EXPIRED')::int expired from u`, [ctx.clientId, BACKLOG_HOURS]);
  await audit(tx, ctx, { entityType: 'settings', action: 'UPDATE', after: { smtp: { host, port, secure: s.secure, user, from } } });
  return { status: 200, body: { configured: true, released: r!.released, expired: r!.expired } };
}

// Отправка ---------------------------------------------------------------------------

export type Sender = (smtp: SmtpSettings, msg: { to: string; subject: string; text: string }) => Promise<void>;

let sender: Sender = async (smtp, msg) => {
  const t = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined, connectionTimeout: 15000 });
  await t.sendMail({ from: smtp.from, to: msg.to, subject: msg.subject, text: msg.text });
};
/** Для тестов: подмена отправки писем. */
export function setSender(s: Sender) { sender = s; }

const MAX_ATTEMPTS = 6;

/** Отправляет созревшие письма всех клиентов с настроенным каналом. Повтор: 1, 2, 4, 8, 16 минут; затем FAILED. */
export async function processOutbox(db: Db, limit = 50): Promise<{ sent: number; failed: number }> {
  // Письма, зависшие в отправке при перезапуске, возвращаются в очередь.
  await db.query("update kam.email_outbox set status='RETRY' where status='SENDING' and next_attempt_at < now() - interval '10 minutes'");
  const { rows } = await db.query<{ client_id: string; id: string; to_email: string; subject: string; body: string; attempts: number }>(
    `update kam.email_outbox o set status='SENDING' where (client_id, id) in (
       select client_id, id from kam.email_outbox where status in ('QUEUED','RETRY') and next_attempt_at <= now()
        order by next_attempt_at limit $1 for update skip locked)
     returning client_id, id, to_email, subject, body, attempts`, [limit]);
  let sent = 0, failed = 0;
  const channels = new Map<string, SmtpSettings | null>();
  for (const m of rows) {
    if (!channels.has(m.client_id)) channels.set(m.client_id, await smtpOf(db, m.client_id));
    const smtp = channels.get(m.client_id);
    if (!smtp) {
      await db.query("update kam.email_outbox set status='NO_CHANNEL' where client_id=$1 and id=$2", [m.client_id, m.id]);
      continue;
    }
    try {
      await sender(smtp, { to: m.to_email, subject: m.subject, text: m.body });
      await db.query("update kam.email_outbox set status='SENT', sent_at=now(), attempts=attempts+1, last_error=null where client_id=$1 and id=$2", [m.client_id, m.id]);
      sent += 1;
    } catch (e) {
      const attempts = m.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await db.query(
        `update kam.email_outbox set status=$3, attempts=$4, last_error=$5, next_attempt_at = now() + make_interval(mins => $6) where client_id=$1 and id=$2`,
        [m.client_id, m.id, final ? 'FAILED' : 'RETRY', attempts, String((e as Error).message ?? e).slice(0, 500), 2 ** (attempts - 1)]);
      failed += 1;
    }
  }
  return { sent, failed };
}

/** Повторить письмо вручную (администратор): FAILED и RETRY уходят в очередь сейчас. */
export async function retryEmail(tx: Tx, ctx: Ctx, id: string): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  if (!isUuid(id)) throw invalid('id', 'Некорректное письмо.');
  const channel = await smtpOf(tx, ctx.clientId);
  const r = await tx.query(`update kam.email_outbox set status=$3, next_attempt_at=now(), attempts = 0 where client_id=$1 and id=$2 and status in ('FAILED','RETRY','NO_CHANNEL','EXPIRED')`,
    [ctx.clientId, id, channel ? 'QUEUED' : 'NO_CHANNEL']);
  return { status: 200, body: { updated: r.rowCount } };
}

export async function testEmail(tx: Tx, ctx: Ctx): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const channel = await smtpOf(tx, ctx.clientId);
  await tx.query(
    `insert into kam.email_outbox(client_id, id, user_id, to_email, subject, body, status) values ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.clientId, randomUUID(), ctx.principal.userId, ctx.principal.email, 'PharmaCheck · Проверка почтового канала',
      'Это тестовое письмо модуля «Переговоры». Если вы его получили, почтовый канал работает.', channel ? 'QUEUED' : 'NO_CHANNEL']);
  return { status: 201, body: { queued: Boolean(channel) } };
}

// Плановые уведомления: напоминания, просрочки шагов и контрольных дат ----------------

export async function runSchedule(db: Db): Promise<{ reminders: number; overdue: number; control: number }> {
  let reminders = 0, overdue = 0, control = 0;
  const { rows: due } = await db.query<{ client_id: string; id: string; campaign_id: string; title: string; candidates: string[]; network: string; ctitle: string; overdue: boolean; due_date: string }>(
    `select s.client_id, s.id, s.campaign_id, s.title, s.candidates, n.name network, c.title ctitle, s.due_date::text due_date, (s.due_date < current_date) overdue
       from kam.approval_step s join kam.campaign c on c.client_id = s.client_id and c.id = s.campaign_id
       join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where s.status='ACTIVE' and s.due_date <= current_date
        and ((s.due_date = current_date and s.reminded_at is null) or (s.due_date < current_date and s.overdue_notified_at is null))`);
  for (const s of due) {
    await withTx(db, async (db) => {
      const deputies = (await db.query<{ deputy_id: string }>('select deputy_id from kam.substitution where client_id=$1 and user_id = any($2::uuid[]) and valid @> current_date', [s.client_id, s.candidates])).rows.map((r) => r.deputy_id);
      if (s.overdue) {
        const managers = (await db.query<{ manager_id: string }>('select manager_id from kam.user_manager where client_id=$1 and user_id = any($2::uuid[]) and valid @> current_date', [s.client_id, s.candidates])).rows.map((r) => r.manager_id);
        await notify(db, s.client_id, { kind: 'STEP_OVERDUE', users: [...s.candidates, ...deputies, ...managers], campaignId: s.campaign_id,
          title: `Просрочен шаг «${s.title}»: ${s.network} — ${s.ctitle}`, body: `Срок решения был ${s.due_date.split('-').reverse().join('.')}.` });
        await db.query('update kam.approval_step set overdue_notified_at=now(), reminded_at=coalesce(reminded_at, now()) where client_id=$1 and id=$2', [s.client_id, s.id]);
        overdue += 1;
      } else {
        await notify(db, s.client_id, { kind: 'STEP_REMINDER', users: [...s.candidates, ...deputies], campaignId: s.campaign_id,
          title: `Сегодня срок шага «${s.title}»: ${s.network} — ${s.ctitle}` });
        await db.query('update kam.approval_step set reminded_at=now() where client_id=$1 and id=$2', [s.client_id, s.id]);
        reminders += 1;
      }
    });
  }
  const { rows: late } = await db.query<{ client_id: string; id: string }>(
    `select c.client_id, c.id from kam.campaign_with_owner c
      where c.owner_id is not null and c.control_date < current_date and c.stage = any(array['PREPARATION','NEGOTIATION','APPROVAL']) and c.control_overdue_notified_at is null`);
  for (const c of late) {
    await withTx(db, async (db) => {
      const { owner_id } = await lockCampaignRecord(db, c.client_id, c.id);
      if (!owner_id) return;
      const { rows: [due] } = await db.query<{ network: string; title: string; control_date: string }>(
        `update kam.campaign c set control_overdue_notified_at=now() from kam.network n
          where c.client_id=$1 and c.id=$2 and n.client_id=c.client_id and n.id=c.network_id
            and c.control_date < current_date and c.stage in ('PREPARATION','NEGOTIATION','APPROVAL') and c.control_overdue_notified_at is null
          returning n.name as network, c.title, c.control_date`, [c.client_id, c.id]);
      if (!due) return;
      const manager = (await db.query<{ manager_id: string }>('select manager_id from kam.user_manager where client_id=$1 and user_id=$2 and valid @> current_date', [c.client_id, owner_id])).rows[0]?.manager_id;
      await notify(db, c.client_id, { kind: 'CONTROL_OVERDUE', users: [owner_id, manager], campaignId: c.id,
        title: `Просрочена контрольная дата: ${due.network} — ${due.title}`, body: `Условия должны были быть согласованы к ${due.control_date.split('-').reverse().join('.')}.` });
      control += 1;
    });
  }
  return { reminders, overdue, control };
}
