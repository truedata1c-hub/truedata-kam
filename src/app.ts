import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from './db.js';
import { ApiError, fromPg, notFound } from './errors.js';
import { changePassword, login, logout, principalFromToken, SESSION_TTL_HOURS, type Principal } from './auth.js';
import { type Ctx, loadAccess } from './access.js';
import { type CommandResult, isUuid, runCommand } from './commands.js';
import { consumeToken, type SsoConfig } from './sso.js';
import { demoPlatform, type DemoPlatformConfig } from './demoPlatform.js';
import * as campaigns from './campaigns.js';
import * as admin from './admin.js';
import { networkEntities, reference } from './reference.js';
import * as versions from './versions.js';
import * as documents from './documents.js';
import * as prior from './prior.js';
import * as settings from './settings.js';
import * as routeTemplates from './routes.js';
import * as approval from './approval.js';
import * as notifications from './notify.js';
import * as network from './network.js';
import { analytics } from './analytics.js';
import { backupStatus } from './ops.js';
import { parseVersion, versionTemplate } from './excel.js';
import { MAX_FILE_BYTES } from './files.js';

export interface AppOptions {
  db: Db;
  logger?: boolean;
  secureCookies?: boolean;
  /** Каталог собранного интерфейса (web/dist). Без него сервис отдаёт только API. */
  webRoot?: string;
  trustProxy?: number | false;
  sso?: SsoConfig | null;
  /** Адреса, которым разрешено встраивать модуль (Content-Security-Policy: frame-ancestors). */
  frameAncestors?: string[];
  demoPlatform?: DemoPlatformConfig | null;
}

const COOKIE = 'kam_session';
const BASE = '/api/kam/v1';

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    trustProxy: opts.trustProxy ? (_addr: string, hop: number) => hop < (opts.trustProxy as number) : false,
  });
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) routes.push({ method: m, url: r.url }); });
  app.decorate('kamRoutes', routes);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  app.decorateRequest('principal', null);

  const frameAncestors = ["'self'", ...(opts.frameAncestors ?? [])].join(' ');
  app.addHook('onSend', async (_req, reply) => {
    // Файлы документов задают собственную, более строгую политику (documents.sendFile).
    if (reply.getHeader('x-kam-file')) reply.removeHeader('x-kam-file');
    else reply.header('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const api = err instanceof ApiError ? err : fromPg(err);
    if (api) return reply.status(api.status).send({ error: { code: api.code, message: api.message, field: api.field, details: api.details }, request_id: req.id });
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 400 && /JSON/i.test(e.message ?? '')) {
      return reply.status(400).send({ error: { code: 'INVALID_JSON', message: 'Некорректный JSON.', field: null, details: {} }, request_id: req.id });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: 'Некорректный запрос.', field: null, details: {} }, request_id: req.id });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера.', field: null, details: {} }, request_id: req.id });
  });

  const tokenOf = (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    return auth?.startsWith('Bearer ') ? auth.slice(7) : req.cookies[COOKIE];
  };
  const setSession = (reply: FastifyReply, token: string) => reply.setCookie(COOKIE, token, {
    // Lax: cookie остаётся «своей» во встроенном окне платформы на том же домене второго уровня (ТЗ §2.2).
    path: '/', httpOnly: true, sameSite: 'lax', secure: opts.secureCookies ?? false, maxAge: SESSION_TTL_HOURS * 3600,
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // Защита от межсайтовых запросов: при входе по cookie изменяющий запрос обязан нести служебный заголовок,
    // который браузер не добавит к запросу с чужой страницы (поддомены *.truedata.tech для cookie — «тот же сайт»).
    // Интерфейс модуля передаёт Idempotency-Key в каждом изменяющем запросе, включая загрузку файлов.
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const viaCookie = !req.headers.authorization?.startsWith('Bearer ') && Boolean(req.cookies[COOKIE]);
    if (unsafe && viaCookie && !req.headers['idempotency-key'] && !req.url.startsWith(`${BASE}/auth/login`)) {
      throw new ApiError(403, 'CSRF_HEADER_REQUIRED', 'Запрос отклонён: нет служебного заголовка. Обновите страницу и повторите.');
    }
    req.principal = await principalFromToken(opts.db, tokenOf(req), (req.params as { clientId?: string }).clientId);
    if (req.principal?.mustChangePassword && req.method !== 'GET' && !req.url.startsWith(`${BASE}/me/password`) && !req.url.startsWith(`${BASE}/auth/`)) {
      throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Смените временный пароль, чтобы продолжить работу.');
    }
  });

  app.get('/healthz', async () => {
    await opts.db.query('select 1');
    return { ok: true, version: process.env.APP_VERSION ?? 'dev' };
  });

  // Вход ------------------------------------------------------------------

  app.post(`${BASE}/auth/login`, async (req, reply) => {
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof b.email !== 'string' || typeof b.password !== 'string') throw new ApiError(400, 'INVALID_JSON', 'Передайте email и password.');
    const s = await login(opts.db, b.email, b.password, req.ip);
    setSession(reply, s.token);
    return { token: s.token, expires_at: s.expiresAt.toISOString(), must_change_password: s.mustChangePassword };
  });

  app.post(`${BASE}/auth/logout`, async (req, reply) => {
    const token = tokenOf(req);
    if (token) await logout(opts.db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Сквозной вход: платформа открывает /sso?token=… во встроенном окне; модуль ставит сессию и открывает рабочую область. */
  app.get('/sso', async (req, reply) => {
    const q = req.query as { token?: string; embed?: string; next?: string };
    const next = typeof q.next === 'string' && /^\/[A-Za-z0-9/_\-#?=&.]*$/.test(q.next) && !q.next.startsWith('//') ? q.next : '/';
    if (!opts.sso) return ssoPage(reply, 503, 'Сквозной вход не настроен на этом стенде.');
    if (typeof q.token !== 'string' || !q.token) return ssoPage(reply, 400, 'Нет токена входа. Откройте раздел из платформы заново.');
    try {
      const s = await consumeToken(opts.db, opts.sso, q.token);
      setSession(reply, s.token);
      const target = new URL(next, 'http://x');
      target.searchParams.set('client', s.clientId);
      if (q.embed === '1') target.searchParams.set('embed', '1');
      return reply.redirect(target.pathname + target.search + target.hash, 303);
    } catch (e) {
      if (e instanceof ApiError) return ssoPage(reply, e.status, e.message);
      throw e;
    }
  });

  if (opts.demoPlatform) await demoPlatform(app, opts.db, opts.demoPlatform);

  const me = (req: FastifyRequest): Principal => {
    if (!req.principal) throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в систему.');
    return req.principal;
  };

  app.get(`${BASE}/me`, async (req) => {
    const p = me(req);
    const ids = [...p.clientIds];
    const clients = ids.length
      ? (await opts.db.query<{ id: string; code: string; name: string; display_name: string }>(
        `select c.id, c.code, c.name, u.display_name from kam.client c join kam.employee_profile u on u.client_id = c.id
          where c.id = any($1) and u.id = $2 order by c.name`, [ids, p.userId])).rows
      : [];
    const companies = [];
    for (const c of clients) {
      const a = await loadAccess(opts.db, p, c.id);
      companies.push({ ...c, roles: a.roleNames, permissions: [...a.permissions].sort(), scopes: [...a.scopes].sort() });
    }
    return { user_id: p.userId, email: p.email, display_name: p.displayName, must_change_password: p.mustChangePassword, via: p.via, companies };
  });

  app.post(`${BASE}/me/password`, async (req) => {
    const p = me(req);
    const b = (req.body ?? {}) as { current_password?: unknown; new_password?: unknown };
    if (typeof b.current_password !== 'string' || typeof b.new_password !== 'string') throw new ApiError(400, 'INVALID_JSON', 'Передайте текущий и новый пароль.');
    await changePassword(opts.db, p.userId, tokenOf(req) ?? null, b.current_password, b.new_password);
    return { ok: true };
  });

  // Маршруты клиента -------------------------------------------------------

  const ctxOf = async (req: FastifyRequest): Promise<Ctx> => {
    const principal = me(req);
    const clientId = (req.params as { clientId: string }).clientId;
    if (!isUuid(clientId)) throw notFound();
    const access = await loadAccess(opts.db, principal, clientId);
    return { db: opts.db, principal, clientId, requestId: req.id, access };
  };
  const send = (reply: FastifyReply, r: CommandResult & { replay?: boolean }) => {
    if (r.etag) reply.header('etag', r.etag);
    if (r.replay) reply.header('idempotent-replay', 'true');
    return reply.status(r.status).send(r.body);
  };
  const command = (fn: (tx: Tx, ctx: Ctx, req: FastifyRequest) => Promise<CommandResult>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await ctxOf(req);
      const r = await runCommand(ctx, { method: req.method, path: req.url.split('?')[0]!, idempotencyKey: req.headers['idempotency-key'] as string | undefined, body: req.body ?? null },
        (tx) => fn(tx, ctx, req));
      return send(reply, r);
    };
  const C = `${BASE}/clients/:clientId`;
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const param = (req: FastifyRequest, k: string) => (req.params as Record<string, string>)[k]!;
  const ifMatch = (req: FastifyRequest) => req.headers['if-match'] as string | undefined;

  app.get(`${C}/reference`, async (req) => reference(await ctxOf(req)));
  app.get(`${C}/reference/networks/:id/legal-entities`, async (req) => networkEntities(await ctxOf(req), param(req, 'id')));

  app.get(`${C}/campaigns`, async (req) => campaigns.listCampaigns(await ctxOf(req), req.query as campaigns.ListQuery));
  app.post(`${C}/campaigns`, command((tx, ctx, req) => campaigns.createCampaign(tx, ctx, body(req))));
  app.get(`${C}/campaigns/:id`, async (req, reply) => {
    const r = await campaigns.getCampaign(await ctxOf(req), param(req, 'id'));
    reply.header('etag', r.etag);
    return r.data;
  });
  app.patch(`${C}/campaigns/:id`, command((tx, ctx, req) => campaigns.updateCampaign(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));
  app.get(`${C}/campaigns/:id/final-snapshot`, async (req) => campaigns.finalSnapshot(await ctxOf(req), param(req, 'id')));
  app.post(`${C}/campaigns/:id/transitions`, command((tx, ctx, req) => campaigns.transition(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));

  // Версии предложения
  app.get(`${C}/campaigns/:id/versions`, async (req) => ({ items: await versions.listVersions(await ctxOf(req), param(req, 'id')) }));
  app.get(`${C}/campaigns/:id/versions/draft`, async (req) => versions.versionDraft(await ctxOf(req), param(req, 'id')));
  app.get(`${C}/campaigns/:id/versions/template.xlsx`, async (req, reply) => {
    const ctx = await ctxOf(req);
    const d = await versions.versionDraft(ctx, param(req, 'id'));
    const card = await campaigns.getCampaign(ctx, param(req, 'id'));
    const brands = (await ctx.db.query<{ id: string; name: string }>('select id, name from kam.brand where client_id=$1 and not archived order by name', [ctx.clientId])).rows;
    const buf = await versionTemplate({ title: `${card.data.network.name} — ${card.data.title}`, periods: d.periods, brands, cells: d.cells });
    const name = `Разбивка ${card.data.network.name} ${card.data.title}.xlsx`.replace(/[\\/:*?"<>|]/g, ' ');
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(buf);
  });
  app.post(`${C}/campaigns/:id/versions/parse`, async (req) => {
    const ctx = await ctxOf(req);
    const d = await versions.versionDraft(ctx, param(req, 'id'));
    if (!req.isMultipart()) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Передайте файл формой multipart/form-data.');
    const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!part) throw new ApiError(422, 'FIELD_REQUIRED', 'Выберите файл.', {}, 'file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', 'Файл больше 5 МБ.', {}, 'file');
    const brands = (await ctx.db.query<{ id: string; name: string }>('select id, name from kam.brand where client_id=$1 and not archived', [ctx.clientId])).rows;
    return parseVersion(buf, d.periods, brands);
  });
  app.get(`${C}/campaigns/:id/versions/:number`, async (req) => versions.getVersion(await ctxOf(req), param(req, 'id'), param(req, 'number')));
  app.post(`${C}/campaigns/:id/versions`, command((tx, ctx, req) => versions.createVersion(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));

  // Согласование
  app.get(`${C}/campaigns/:id/approval`, async (req) => approval.getApproval(await ctxOf(req), param(req, 'id')));
  app.post(`${C}/campaigns/:id/approval/submit`, command((tx, ctx, req) => approval.submit(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));
  app.post(`${C}/campaigns/:id/approval/withdraw`, command((tx, ctx, req) => approval.withdraw(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));
  app.post(`${C}/campaigns/:id/approval/decision`, command((tx, ctx, req) => approval.decide(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));
  app.get(`${C}/my-decisions`, async (req) => approval.myDecisions(await ctxOf(req), (req.query as { status?: string }).status));
  app.get(`${C}/my-decisions/count`, async (req) => ({ pending: await approval.pendingCount(await ctxOf(req)) }));
  app.get(`${C}/substitutions`, async (req) => approval.listSubstitutions(await ctxOf(req)));
  app.post(`${C}/substitutions`, command((tx, ctx, req) => approval.createSubstitution(tx, ctx, body(req))));
  app.post(`${C}/substitutions/:sid/end`, command((tx, ctx, req) => approval.deleteSubstitution(tx, ctx, param(req, 'sid'))));
  app.get(`${C}/route-templates`, async (req) => routeTemplates.listTemplates(await ctxOf(req)));
  app.post(`${C}/route-templates`, command((tx, ctx, req) => routeTemplates.saveTemplate(tx, ctx, null, body(req))));
  app.put(`${C}/route-templates/:tid`, command((tx, ctx, req) => routeTemplates.saveTemplate(tx, ctx, param(req, 'tid'), body(req))));
  app.post(`${C}/route-templates/:tid/archive`, command((tx, ctx, req) => routeTemplates.archiveTemplate(tx, ctx, param(req, 'tid'))));
  app.put(`${C}/route-rules`, command((tx, ctx, req) => routeTemplates.saveRules(tx, ctx, body(req))));
  app.post(`${C}/route-templates/preview`, async (req) => routeTemplates.previewTemplate(await ctxOf(req), body(req)));

  app.get(`${C}/backups`, async (req) => backupStatus(await ctxOf(req)));
  app.get(`${C}/analytics`, async (req) => analytics(await ctxOf(req), req.query as Record<string, string>));

  // Работа с сетью и переписка
  app.get(`${C}/networks/:nid/contacts`, async (req) => network.listContacts(await ctxOf(req), param(req, 'nid')));
  app.post(`${C}/networks/:nid/contacts`, command((tx, ctx, req) => network.saveContact(tx, ctx, param(req, 'nid'), null, body(req))));
  app.put(`${C}/contacts/:cid`, command((tx, ctx, req) => network.saveContact(tx, ctx, null, param(req, 'cid'), body(req))));
  app.get(`${C}/campaigns/:id/activities`, async (req) => network.listActivities(await ctxOf(req), param(req, 'id')));
  app.post(`${C}/campaigns/:id/activities`, command((tx, ctx, req) => network.saveActivity(tx, ctx, param(req, 'id'), null, body(req))));
  app.put(`${C}/campaigns/:id/activities/:aid`, command((tx, ctx, req) => network.saveActivity(tx, ctx, param(req, 'id'), param(req, 'aid'), body(req))));
  app.get(`${C}/campaigns/:id/comments`, async (req) => network.listComments(await ctxOf(req), param(req, 'id')));
  app.post(`${C}/campaigns/:id/comments`, command((tx, ctx, req) => network.addComment(tx, ctx, param(req, 'id'), body(req))));

  // Уведомления и почтовый канал
  app.get(`${C}/notifications`, async (req) => notifications.listNotifications(await ctxOf(req), req.query as { unread?: string }));
  app.post(`${C}/notifications/read`, command((tx, ctx, req) => notifications.markRead(tx, ctx, body(req))));
  app.get(`${C}/notification-prefs`, async (req) => notifications.getPrefs(await ctxOf(req)));
  app.put(`${C}/notification-prefs`, command((tx, ctx, req) => notifications.savePrefs(tx, ctx, body(req))));
  app.get(`${C}/mail`, async (req) => notifications.getMailSettings(await ctxOf(req)));
  app.put(`${C}/mail`, command((tx, ctx, req) => notifications.saveMailSettings(tx, ctx, body(req))));
  app.post(`${C}/mail/test`, command((tx, ctx) => notifications.testEmail(tx, ctx)));
  app.post(`${C}/mail/:mid/retry`, command((tx, ctx, req) => notifications.retryEmail(tx, ctx, param(req, 'mid'))));

  // Документы
  app.get(`${C}/campaigns/:id/documents`, async (req) => {
    const ctx = await ctxOf(req);
    await campaigns.getCampaign(ctx, param(req, 'id'));
    return { items: await documents.listDocuments(ctx, param(req, 'id')) };
  });
  app.post(`${C}/campaigns/:id/documents`, async (req, reply) => send(reply, await documents.upload(await ctxOf(req), param(req, 'id'), req)));
  app.get(`${C}/campaigns/:id/documents/:docId/file`, async (req, reply) =>
    documents.sendFile(await ctxOf(req), param(req, 'id'), param(req, 'docId'), (req.query as { inline?: string }).inline === '1', reply, frameAncestors));
  app.post(`${C}/campaigns/:id/documents/:docId/archive`, command((tx, ctx, req) => documents.archive(tx, ctx, param(req, 'id'), param(req, 'docId'), body(req))));

  // Прошлые периоды и настройки
  app.get(`${C}/prior-periods`, async (req) => prior.summary(await ctxOf(req), (req.query as { year?: string }).year));
  app.get(`${C}/prior-periods/template.xlsx`, async (req, reply) => {
    const year = (req.query as { year?: string }).year;
    const buf = await prior.template(await ctxOf(req), year);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="prior.xlsx"; filename*=UTF-8''${encodeURIComponent(`Прошлый период ${year}.xlsx`)}`);
    return reply.send(buf);
  });
  app.post(`${C}/prior-periods/import`, async (req, reply) => send(reply, await prior.importFile(await ctxOf(req), req)));
  app.get(`${C}/settings`, async (req) => settings.getSettings(await ctxOf(req)));
  app.put(`${C}/settings/thresholds`, command((tx, ctx, req) => settings.saveThresholds(tx, ctx, body(req))));

  app.get(`${C}/roles`, async (req) => admin.listRoles(await ctxOf(req)));
  app.post(`${C}/roles`, command((tx, ctx, req) => admin.createRole(tx, ctx, body(req))));
  app.put(`${C}/roles/:id`, command((tx, ctx, req) => admin.updateRole(tx, ctx, param(req, 'id'), body(req))));

  app.get(`${C}/users`, async (req) => admin.listUsers(await ctxOf(req)));
  app.post(`${C}/users`, command((tx, ctx, req) => admin.inviteUser(tx, ctx, body(req))));
  app.patch(`${C}/users/:id`, command((tx, ctx, req) => admin.updateUser(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/users/:id/password-reset`, command((tx, ctx, req) => admin.resetPassword(tx, ctx, param(req, 'id'))));
  app.put(`${C}/users/:id/manager`, command((tx, ctx, req) => admin.setManager(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/users/:id/assignments`, command((tx, ctx, req) => admin.addAssignment(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/assignments/:id/end`, command((tx, ctx, req) => admin.endAssignment(tx, ctx, param(req, 'id'), body(req))));

  app.get(`${C}/networks`, async (req) => admin.listNetworks(await ctxOf(req)));
  app.post(`${C}/networks`, command((tx, ctx, req) => admin.saveNetwork(tx, ctx, null, body(req))));
  app.put(`${C}/networks/:id`, command((tx, ctx, req) => admin.saveNetwork(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/networks/:id/legal-entities`, command((tx, ctx, req) => admin.saveLegalEntity(tx, ctx, param(req, 'id'), null, body(req))));
  app.put(`${C}/networks/:id/legal-entities/:leId`, command((tx, ctx, req) => admin.saveLegalEntity(tx, ctx, param(req, 'id'), param(req, 'leId'), body(req))));
  app.post(`${C}/network-groups`, command((tx, ctx, req) => admin.saveGroup(tx, ctx, body(req))));

  app.get(`${C}/brands`, async (req) => admin.listBrands(await ctxOf(req)));
  app.post(`${C}/brands`, command((tx, ctx, req) => admin.saveBrand(tx, ctx, null, body(req))));
  app.put(`${C}/brands/:id`, command((tx, ctx, req) => admin.saveBrand(tx, ctx, param(req, 'id'), body(req))));

  app.get(`${C}/campaign-types`, async (req) => admin.listTypes(await ctxOf(req)));
  app.post(`${C}/campaign-types`, command((tx, ctx, req) => admin.saveType(tx, ctx, null, body(req))));
  app.put(`${C}/campaign-types/:id`, command((tx, ctx, req) => admin.saveType(tx, ctx, param(req, 'id'), body(req))));

  app.get(`${C}/audit`, async (req) => admin.listAudit(await ctxOf(req), req.query as { entity_type?: string; before?: string }));

  // Интерфейс ---------------------------------------------------------------

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, { root: opts.webRoot, index: ['index.html'], wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Ресурс отсутствует или недоступен.', field: null, details: {} } });
      }
      return reply.sendFile('index.html');
    });
  }
  return app;
}

function ssoPage(reply: FastifyReply, status: number, message: string) {
  const esc = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return reply.status(status).type('text/html; charset=utf-8').send(
    `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход</title>
     <body style="font:13px Inter,-apple-system,Arial,sans-serif;color:#344054;display:grid;place-items:center;min-height:90vh">
     <div style="max-width:420px;border:1px solid #eaecf0;border-radius:9px;padding:24px"><b style="color:#101828">Не удалось открыть переговоры</b>
     <p>${esc}</p></div></body></html>`);
}
