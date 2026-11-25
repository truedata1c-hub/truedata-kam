// Учётные записи и сессии модуля. Вход по паролю — для демо и администрирования; для заказчика основной вход —
// сквозной из платформы (sso.ts), он создаёт такую же сессию. Модуль изолирован, как auth.ts в MDM.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import { ApiError } from './errors.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_TTL_HOURS = 12;

export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  /** Клиенты, в которых у пользователя есть действующее членство. */
  clientIds: Set<string>;
  mustChangePassword: boolean;
  via: 'PASSWORD' | 'SSO';
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new ApiError(422, 'WEAK_PASSWORD', 'Пароль должен быть не короче 10 символов.', {}, 'new_password');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [alg, saltB64, keyB64] = (stored ?? 'scrypt$AAAA$AAAA').split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length || 32, PARAMS);
  return stored !== null && expected.length === key.length && timingSafeEqual(key, expected);
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

const LIMIT_WINDOW = '15 minutes';
const MAX_EMAIL_FAILS = 5;
const MAX_IP_FAILS = 30;

export interface Session { token: string; expiresAt: Date; mustChangePassword: boolean }

export async function createSession(db: Db, userId: string, via: 'PASSWORD' | 'SSO'): Promise<Session> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
  await db.query('insert into kam.session(token_hash, user_id, expires_at, via) values ($1,$2,$3,$4)', [tokenHash(token), userId, expiresAt, via]);
  const { rows } = await db.query<{ must_change_password: boolean }>(
    'update kam.app_user set last_login_at=now() where id=$1 returning must_change_password', [userId]);
  // При сквозном входе пароль модуля не используется, поэтому и требовать его смены незачем.
  return { token, expiresAt, mustChangePassword: via === 'PASSWORD' && Boolean(rows[0]?.must_change_password) };
}

/**
 * Вход по паролю. Подбор ограничен: 5 неудачных попыток на адрес или 30 с одного IP за 15 минут — дальше 429.
 * Ответ на неверный адрес и неверный пароль одинаковый.
 */
export async function login(db: Db, email: string, password: string, ip = 'unknown'): Promise<Session> {
  const addr = email.trim().toLowerCase().slice(0, 320);
  const { rows: [fails] } = await db.query<{ by_email: string; by_ip: string }>(
    `select count(*) filter (where email=$1) by_email, count(*) filter (where ip=$2) by_ip
       from kam.login_attempt where not ok and at > now() - interval '${LIMIT_WINDOW}' and (email=$1 or ip=$2)`, [addr, ip]);
  if (Number(fails!.by_email) >= MAX_EMAIL_FAILS || Number(fails!.by_ip) >= MAX_IP_FAILS) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Слишком много неудачных попыток входа. Повторите через 15 минут или попросите администратора сбросить пароль.');
  }
  const { rows } = await db.query<{ id: string; password_hash: string | null; disabled: boolean }>(
    'select id, password_hash, disabled from kam.app_user where email = $1', [addr]);
  const u = rows[0];
  const ok = await verifyPassword(password, u?.password_hash ?? null);
  await db.query('insert into kam.login_attempt(email, ip, ok) values ($1,$2,$3)', [addr, ip, Boolean(u && ok && !u.disabled)]);
  if (Math.random() < 0.02) await db.query("delete from kam.login_attempt where at < now() - interval '1 day'");
  if (!u || !ok || u.disabled) throw new ApiError(401, 'UNAUTHENTICATED', 'Неверный адрес или пароль.');
  return createSession(db, u.id, 'PASSWORD');
}

/** Смена своего пароля: нужен текущий; остальные сессии пользователя закрываются. */
export async function changePassword(db: Db, userId: string, currentToken: string | null, current: string, next: string): Promise<void> {
  const { rows } = await db.query<{ password_hash: string | null }>('select password_hash from kam.app_user where id=$1', [userId]);
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) throw new ApiError(422, 'WRONG_PASSWORD', 'Текущий пароль указан неверно.', {}, 'current_password');
  if (current === next) throw new ApiError(422, 'WEAK_PASSWORD', 'Новый пароль должен отличаться от текущего.', {}, 'new_password');
  const hash = await hashPassword(next);
  await db.query('update kam.app_user set password_hash=$2, must_change_password=false where id=$1', [userId, hash]);
  await db.query('delete from kam.session where user_id=$1 and token_hash <> $2', [userId, currentToken ? tokenHash(currentToken) : '']);
}

/** Временный пароль: 16 символов без похожих букв, показывается администратору один раз. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('delete from kam.session where token_hash = $1', [tokenHash(token)]);
}

export async function principalFromToken(db: Db, token: string | undefined, clientId?: string): Promise<Principal | null> {
  if (!token) return null;
  const { rows } = await db.query<{ id: string; email: string; display_name: string; member_name: string | null; must_change_password: boolean; via: 'PASSWORD' | 'SSO'; client_id: string | null }>(
    `select u.id, u.email, u.display_name, m.display_name member_name, u.must_change_password, s.via, m.client_id
       from kam.session s join kam.app_user u on u.id = s.user_id
       left join kam.membership m on m.user_id = u.id and m.active
      where s.token_hash = $1 and s.expires_at > now() and not u.disabled`, [tokenHash(token)]);
  const first = rows[0];
  if (!first) return null;
  const member = rows.length === 1 ? first : rows.find((r) => r.client_id === clientId);
  return {
    userId: first.id, email: first.email, displayName: member?.member_name ?? first.display_name, via: first.via,
    mustChangePassword: first.via === 'PASSWORD' && first.must_change_password,
    clientIds: new Set(rows.map((r) => r.client_id).filter((c): c is string => Boolean(c))),
  };
}

export async function createUser(db: Pick<Db, 'query'>, email: string, displayName: string, password: string | null, mustChange = false): Promise<string> {
  const id = randomUUID();
  await db.query('insert into kam.app_user(id, email, display_name, password_hash, must_change_password) values ($1,$2,$3,$4,$5)',
    [id, email.trim().toLowerCase(), displayName, password === null ? null : await hashPassword(password), mustChange]);
  return id;
}
