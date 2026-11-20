import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { ssoConfigFromEnv } from './sso.js';
import { upgradeDemo } from './demo.js';
import { processOutbox, runSchedule } from './notify.js';
import { housekeeping } from './housekeeping.js';

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

// Стенд: при выпуске с новой версией демо-набора набор пересоздаётся после запуска (пароли демо-пользователей прежние).
if (process.env.DEMO_AUTO_UPGRADE === '1' && process.env.KAM_DEMO_PASSWORD) {
  upgradeDemo(db, process.env.KAM_DEMO_PASSWORD, process.env.DEMO_EMAIL_DOMAIN)
    .then((done) => { if (done) app.log.info('demo data set upgraded'); })
    .catch((e) => app.log.error(e, 'demo upgrade failed'));
}

// Фоновые задачи: очередь писем — раз в 30 секунд, напоминания и просрочки — раз в 5 минут.
let busyMail = false, busySchedule = false;
const mailTimer = setInterval(() => {
  if (busyMail) return;
  busyMail = true;
  processOutbox(db).then((r) => { if (r.sent || r.failed) app.log.info(r, 'email outbox'); }).catch((e) => app.log.error(e, 'email outbox failed')).finally(() => { busyMail = false; });
}, 30_000);
const scheduleTick = () => {
  if (busySchedule) return;
  busySchedule = true;
  runSchedule(db).then((r) => { if (r.reminders || r.overdue || r.control) app.log.info(r, 'notifications schedule'); }).catch((e) => app.log.error(e, 'schedule failed')).finally(() => { busySchedule = false; });
};
const scheduleTimer = setInterval(scheduleTick, 5 * 60_000);
setTimeout(scheduleTick, 20_000);

// Очистка служебных таблиц — раз в час.
const cleanTick = () => {
  housekeeping(db).then((r) => { if (Object.values(r).some(Boolean)) app.log.info(r, 'housekeeping'); }).catch((e) => app.log.error(e, 'housekeeping failed'));
};
const cleanTimer = setInterval(cleanTick, 60 * 60_000);
setTimeout(cleanTick, 60_000);

const shutdown = async () => {
  clearInterval(mailTimer);
  clearInterval(scheduleTimer);
  clearInterval(cleanTimer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
