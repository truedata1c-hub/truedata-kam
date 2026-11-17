import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
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
  app.decorateRequest('principal', null);

  const frameAncestors = ["'self'", ...(opts.frameAncestors ?? [])].join(' ');
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
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
    req.principal = await principalFromToken(opts.db, tokenOf(req));
    if (req.principal?.mustChangePassword && req.method !== 'GET' && !req.url.startsWith(`${BASE}/me/password`) && !req.url.startsWith(`${BASE}/auth/`)) {
      throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Смените временный пароль, чтобы продолжить работу.');
    }
  });

  app.get('/healthz', async () => {
    await opts.db.query('select 1');
    return { ok: true };
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
      ? (await opts.db.query<{ id: string; code: string; name: string }>('select id, code, name from kam.client where id = any($1) order by name', [ids])).rows
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
  app.post(`${C}/campaigns/:id/transitions`, command((tx, ctx, req) => campaigns.transition(tx, ctx, param(req, 'id'), ifMatch(req), body(req))));

  app.get(`${C}/roles`, async (req) => admin.listRoles(await ctxOf(req)));
  app.post(`${C}/roles`, command((tx, ctx, req) => admin.createRole(tx, ctx, body(req))));
  app.put(`${C}/roles/:id`, command((tx, ctx, req) => admin.updateRole(tx, ctx, param(req, 'id'), body(req))));

  app.get(`${C}/users`, async (req) => admin.listUsers(await ctxOf(req)));
  app.post(`${C}/users`, command((tx, ctx, req) => admin.inviteUser(tx, ctx, body(req))));
  app.patch(`${C}/users/:id`, command((tx, ctx, req) => admin.updateUser(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/users/:id/password-reset`, command((tx, ctx, req) => admin.resetPassword(tx, ctx, param(req, 'id'))));
  app.put(`${C}/users/:id/manager`, command((tx, ctx, req) => admin.setManager(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/users/:id/assignments`, command((tx, ctx, req) => admin.addAssignment(tx, ctx, param(req, 'id'), body(req))));
  app.post(`${C}/assignments/:id/end`, command((tx, ctx, req) => admin.endAssignment(tx, ctx, param(req, 'id'))));

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
