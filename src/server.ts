import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { ssoConfigFromEnv } from './sso.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const db = createPool(url);
if (process.env.MIGRATE_ON_START !== 'false') {
  const applied = await migrate(db);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
}

const sso = ssoConfigFromEnv();
const demo = process.env.DEMO_PLATFORM_PASSWORD && process.env.SSO_DEMO_PRIVATE_KEY && sso
  ? { password: process.env.DEMO_PLATFORM_PASSWORD, privateKey: process.env.SSO_DEMO_PRIVATE_KEY, issuer: sso.issuer, audience: sso.audience, clientCode: process.env.DEMO_CLIENT_CODE ?? 'DEMO' }
  : null;

const webRoot = process.env.WEB_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const trustProxy = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false;
const frameAncestors = (process.env.FRAME_ANCESTORS ?? '').split(/[\s,]+/).filter((s) => /^https:\/\/[a-z0-9.*-]+(:\d+)?$/i.test(s));
const app = await buildApp({
  db, logger: true, secureCookies: process.env.SECURE_COOKIES !== 'false', webRoot, trustProxy, sso, frameAncestors, demoPlatform: demo,
});
const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
