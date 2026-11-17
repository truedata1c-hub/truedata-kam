import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { createUser } from '../src/auth.js';
import { seedDemo } from '../src/demo.js';
import { createPublicKey } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
export const PASSWORD = 'correct-horse-battery';
export const DOMAIN = 'demo.test';

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  demo: string;
  other: string;
  keys: { privatePem: string; publicPem: string };
  tokens: Record<string, string>;
  login: (who: string) => Promise<string>;
  close: () => Promise<void>;
}

/** Отдельная база на каждый тестовый файл: миграции, демо-набор и второй клиент с одним пользователем. */
export async function setup(): Promise<TestEnv> {
  const name = 'kam_test_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = '/' + name;
  const db = createPool(url.toString());
  await migrate(db);
  const { clientId: demo } = await seedDemo(db, { password: PASSWORD, domain: DOMAIN, today: '2026-11-17' });
  const other = randomUUID();
  await db.query("insert into kam.client(id, code, name) values ($1,'OTHER','Другой клиент')", [other]);
  const roleId = randomUUID();
  await db.query("insert into kam.business_role(client_id, id, name, permissions, scope) values ($1,$2,'Администратор',$3,'ALL')", [other, roleId, ['ADMIN', 'CAMPAIGN_EDIT']]);
  const uid = await createUser(db, `admin@other.test`, 'Админ другого клиента', PASSWORD);
  await db.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [other, uid]);
  await db.query('insert into kam.user_business_role(client_id, user_id, role_id) values ($1,$2,$3)', [other, uid, roleId]);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const app = await buildApp({
    db, sso: { issuer: 'test-platform', audience: 'pharmacheck-kam', publicKeys: [createPublicKey(keys.publicPem)] },
    frameAncestors: ['https://app.truedata.tech'],
    demoPlatform: { password: 'stand-pass', privateKey: keys.privatePem, issuer: 'test-platform', audience: 'pharmacheck-kam', clientCode: 'DEMO' },
  });
  const tokens: Record<string, string> = {};
  const login = async (who: string) => {
    const email = who.includes('@') ? who : `${who}@${DOMAIN}`;
    const res = await app.inject({ method: 'POST', url: '/api/kam/v1/auth/login', payload: { email, password: PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login ${who}: ${res.body}`);
    tokens[who] = res.json().token;
    return tokens[who]!;
  };
  return {
    app, db, demo, other, keys, tokens, login,
    close: async () => {
      await app.close();
      await db.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database ${name} with (force)`);
      await a.end();
    },
  };
}

export interface Call {
  method?: string;
  as?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string | null;
  query?: Record<string, string>;
}

export function api(env: TestEnv) {
  return async (path: string, o: Call = {}) => {
    const method = o.method ?? (o.body !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${env.tokens[o.as] ?? (await env.login(o.as))}`;
    if (o.ifMatch) headers['if-match'] = o.ifMatch;
    if (method !== 'GET' && o.key !== null) headers['idempotency-key'] = o.key ?? randomUUID();
    const qs = o.query ? '?' + new URLSearchParams(o.query).toString() : '';
    const res = await env.app.inject({ method, url: path + qs, headers, payload: o.body as object | undefined });
    let json: any = null;
    try { json = res.json(); } catch { /* пустое тело */ }
    return { status: res.statusCode, json, etag: res.headers.etag as string | undefined, headers: res.headers, body: res.body };
  };
}

export const C = (env: TestEnv, client = env.demo) => `/api/kam/v1/clients/${client}`;
