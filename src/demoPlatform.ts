// Демо-платформа: страница, имитирующая основную систему TrueData с пунктом «Переговоры».
// Нужна, чтобы проверить сквозной вход и встроенный режим до подключения настоящей платформы (ТЗ §2.2).
// Защищена паролем стенда (HTTP Basic). В рабочей схеме эту роль выполняет платформа: она подписывает токен своим ключом.

import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { signToken } from './sso.js';

export interface DemoPlatformConfig {
  password: string;
  privateKey: string;
  issuer: string;
  audience: string;
  clientCode: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

function authorized(req: FastifyRequest, password: string): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return timingSafeEqual(sha(pass), sha(password));
}

function challenge(reply: FastifyReply) {
  return reply.status(401).header('WWW-Authenticate', 'Basic realm="TrueData demo platform", charset="UTF-8"').send('Требуется пароль стенда.');
}

export async function demoPlatform(app: FastifyInstance, db: Db, cfg: DemoPlatformConfig) {
  app.get('/demo-platform', async (req, reply) => {
    if (!authorized(req, cfg.password)) return challenge(reply);
    const { rows } = await db.query<{ email: string; name: string; roles: string }>(
      `select u.email, u.display_name name, coalesce(string_agg(r.name, ', ' order by r.name), 'без роли') roles
         from kam.client c join kam.employee_profile u on u.client_id = c.id and u.active and not u.disabled
         left join kam.user_business_role ur on ur.client_id = u.client_id and ur.user_id = u.id
         left join kam.business_role r on r.client_id = ur.client_id and r.id = ur.role_id and not r.archived
        where c.code = $1 group by u.email, u.display_name order by u.display_name`, [cfg.clientCode]);
    const options = rows.map((r) => `<option value="${esc(r.email)}">${esc(r.name)} — ${esc(r.roles)}</option>`).join('');
    return reply.type('text/html; charset=utf-8').send(PAGE.replace('{{OPTIONS}}', options));
  });

  app.post('/demo-platform/token', async (req, reply) => {
    if (!authorized(req, cfg.password)) return challenge(reply);
    const email = String((req.body as { email?: unknown } | null)?.email ?? '').toLowerCase();
    const u = (await db.query<{ id: string; display_name: string }>(
      `select u.id, u.display_name from kam.employee_profile u join kam.client c on c.id = u.client_id
        where u.email = $1 and c.code = $2 and u.active and not u.disabled`, [email, cfg.clientCode])).rows[0];
    if (!u) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Пользователь не найден.' } });
    // Демо-платформа представляет пользователя его же идентификатором — как это сделала бы настоящая платформа.
    const token = signToken(cfg.privateKey, { iss: cfg.issuer, aud: cfg.audience, sub: `demo:${u.id}`, email, name: u.display_name, client: cfg.clientCode });
    return { url: `/sso?embed=1&token=${encodeURIComponent(token)}` };
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const NAV = ['Дашборды', 'Переговоры', 'Договоры', 'Базовые отчеты', 'Мои отчеты', 'Общие отчеты'];

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrueData · демо-платформа</title><link rel="icon" href="/favicon.png">
<style>
  body{margin:0;font:12px/18px Inter,-apple-system,"Helvetica Neue",Arial,sans-serif;color:#101828;display:grid;grid-template-columns:220px 1fr;min-height:100vh}
  aside{border-right:1px solid #eaecf0;padding:12px 5px}
  aside img{width:100px;height:28px;object-fit:contain;object-position:left;margin:0 7px 10px}
  .prod{font-size:13.5px;font-weight:700;color:#a1a8b4;padding:6px 7px}
  .nav{height:30px;display:flex;align-items:center;padding:0 7.5px;border-radius:6px;font-weight:600;color:#344054}
  .nav.active{background:#eaecf0}.nav.off{color:#a1a8b4}
  main{min-width:0;display:flex;flex-direction:column}
  header{height:44px;display:flex;align-items:center;gap:12px;padding:6px 12px;color:#667085}
  header b{padding:3px 6px;background:#f2f4f7;border-radius:4.5px;color:#344054}
  .who{margin-left:auto;display:flex;gap:8px;align-items:center}
  select{height:30px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;font:inherit;max-width:420px}
  .note{background:#fff4df;color:#7a4b16;margin:0 12px;padding:6px 10px;border-radius:8px}
  iframe{flex:1;border:0;width:100%;min-height:600px}
</style></head>
<body>
<aside><img src="/truedata-logo.png" alt="TrueData"><div class="prod">PharmaCheck</div>
${NAV.map((n) => `<div class="nav ${n === 'Переговоры' ? 'active' : 'off'}">${n}</div>`).join('')}
</aside>
<main>
  <header><span>⌂</span><span>›</span><span>Переговоры</span><span id="crumbSep" hidden>›</span><b id="crumb" hidden></b>
    <div class="who"><span>Пользователь платформы</span><select id="user">{{OPTIONS}}</select></div></header>
  <div class="note">Демо-платформа: имитирует основную систему. Выбор пользователя — это вход в платформу; модуль открывается сквозным входом без пароля.</div>
  <iframe id="frame" title="Переговоры"></iframe>
</main>
<script>
  const sel = document.getElementById('user'), frame = document.getElementById('frame');
  const saved = localStorage.getItem('demoPlatformUser'); if (saved) sel.value = saved;
  async function open() {
    localStorage.setItem('demoPlatformUser', sel.value);
    const r = await fetch('/demo-platform/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: sel.value }) });
    if (!r.ok) { alert('Не удалось выпустить токен'); return; }
    frame.src = (await r.json()).url;
  }
  sel.addEventListener('change', open); open();
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'kam:title') { const c = document.getElementById('crumb'); c.textContent = e.data.title || ''; c.hidden = !e.data.title; document.getElementById('crumbSep').hidden = !e.data.title; }
  });
</script>
</body></html>`;
