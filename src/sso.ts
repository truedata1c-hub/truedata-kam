// Сквозной вход из платформы (ТЗ §2.2). Платформа подписывает одноразовый токен (JWT, EdDSA/Ed25519) на ≤ 2 минуты;
// модуль проверяет подпись открытым ключом платформы, срок, издателя, адресата и одноразовость jti,
// находит или создаёт учётную запись и членство в клиенте и открывает собственную сессию.

import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { ApiError } from './errors.js';
import { createSession, type Session } from './auth.js';

export interface SsoConfig {
  issuer: string;
  audience: string;
  publicKeys: KeyObject[];
}

export interface SsoClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string;
  /** Код клиента (компании) в модуле. */
  client: string;
  iat: number;
  exp: number;
  jti: string;
}

const MAX_LIFETIME_S = 120;
const CLOCK_SKEW_S = 30;

const pem = (v: string) => v.replace(/\\n/g, '\n').trim();

export function ssoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SsoConfig | null {
  if (!env.SSO_PUBLIC_KEY) return null;
  const keys = pem(env.SSO_PUBLIC_KEY).split(/(?=-----BEGIN PUBLIC KEY-----)/).filter(Boolean).map((k) => createPublicKey(k));
  return { issuer: env.SSO_ISSUER ?? 'truedata-platform', audience: env.SSO_AUDIENCE ?? 'pharmacheck-kam', publicKeys: keys };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Подпись токена — для демо-платформы и тестов. В рабочей схеме токен выпускает сервер платформы. */
export function signToken(privateKeyPem: string, claims: Omit<SsoClaims, 'iat' | 'exp' | 'jti'> & Partial<Pick<SsoClaims, 'iat' | 'exp' | 'jti'>>): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SsoClaims = { iat: now, exp: now + 60, jti: randomUUID(), ...claims };
  const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64u(JSON.stringify(full));
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(pem(privateKeyPem)));
  return `${head}.${body}.${b64u(sig)}`;
}

const reject = (reason: string) => new ApiError(401, 'SSO_REJECTED', 'Не удалось выполнить вход из платформы. Откройте раздел заново.', { reason });

export function verifyToken(cfg: SsoConfig, token: string, nowS = Math.floor(Date.now() / 1000)): SsoClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw reject('format');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: Partial<SsoClaims>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch { throw reject('format'); }
  if (header.alg !== 'EdDSA') throw reject('alg');
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  if (!cfg.publicKeys.some((k) => verify(null, data, k, sig))) throw reject('signature');
  if (claims.iss !== cfg.issuer) throw reject('issuer');
  if (claims.aud !== cfg.audience) throw reject('audience');
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') throw reject('time');
  if (claims.exp < nowS - CLOCK_SKEW_S || claims.iat > nowS + CLOCK_SKEW_S) throw reject('expired');
  if (claims.exp - claims.iat > MAX_LIFETIME_S) throw reject('lifetime');
  for (const k of ['sub', 'email', 'name', 'client', 'jti'] as const) {
    if (typeof claims[k] !== 'string' || !claims[k]) throw reject('claims');
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(claims.email!)) throw reject('claims');
  return claims as SsoClaims;
}

/** Проверяет токен, гасит jti, находит или создаёт пользователя и членство; возвращает сессию и клиента. */
export async function consumeToken(db: Db, cfg: SsoConfig, token: string): Promise<Session & { clientId: string }> {
  const c = verifyToken(cfg, token);
  const result = await withTx(db, async (tx) => {
    const used = await tx.query('insert into kam.sso_token_use(issuer, jti, expires_at) values ($1,$2,to_timestamp($3)) on conflict do nothing',
      [c.iss, c.jti, c.exp]);
    if (!used.rowCount) throw reject('replay');
    const client = (await tx.query<{ id: string }>('select id from kam.client where code=$1', [c.client])).rows[0];
    if (!client) throw new ApiError(403, 'SSO_UNKNOWN_CLIENT', 'Компания не подключена к модулю переговоров. Обратитесь к администратору.');
    const email = c.email.trim().toLowerCase();
    let userId = (await tx.query<{ user_id: string }>('select user_id from kam.external_identity where issuer=$1 and subject=$2', [c.iss, c.sub])).rows[0]?.user_id;
    if (!userId) {
      userId = (await tx.query<{ id: string }>('select id from kam.app_user where email=$1', [email])).rows[0]?.id;
      if (!userId) {
        userId = randomUUID();
        await tx.query('insert into kam.app_user(id, email, display_name) values ($1,$2,$3)', [userId, email, c.name.slice(0, 120)]);
      }
      await tx.query('insert into kam.external_identity(issuer, subject, user_id) values ($1,$2,$3)', [c.iss, c.sub, userId]);
    }
    const u = (await tx.query<{ disabled: boolean }>('select disabled from kam.app_user where id=$1', [userId])).rows[0]!;
    if (u.disabled) throw new ApiError(403, 'USER_DISABLED', 'Учётная запись заблокирована. Обратитесь к администратору.');
    const m = (await tx.query<{ active: boolean }>('select active from kam.membership where client_id=$1 and user_id=$2', [client.id, userId])).rows[0];
    if (!m) await tx.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [client.id, userId]);
    else if (!m.active) throw new ApiError(403, 'MEMBERSHIP_DISABLED', 'Доступ к модулю отключён администратором.');
    if (Math.random() < 0.05) await tx.query("delete from kam.sso_token_use where expires_at < now() - interval '1 day'");
    return { userId, clientId: client.id };
  });
  const s = await createSession(db, result.userId, 'SSO');
  return { ...s, clientId: result.clientId };
}
