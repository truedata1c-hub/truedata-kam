// Демонстрационный набор (ТЗ §1 п. 20): российские сети и КАМы из прототипа, оргструктура, роли, бренды,
// около 80 кампаний на разных этапах. Данные синтетические: ИНН сгенерированы с верным контрольным числом,
// бренды вымышлены. Генерация детерминирована, повторный запуск с --reset воспроизводит тот же набор.

import { randomUUID } from 'node:crypto';
import { todayIso } from './time.js';
import type { Db, Tx } from './db.js';
import { withTx } from './db.js';
import { hashPassword } from './auth.js';
import { periodsFor, type Split } from './periods.js';
import { versionTemplate } from './excel.js';
import { filesDir, mimeOf, storeBuffer } from './files.js';
import { writeSetting } from './settings.js';
import ExcelJS from 'exceljs';
import { computeRoute } from './routes.js';
import { addWorkdays } from './approval.js';

export const DEMO_CODE = 'DEMO';
/** Версия демо-набора: при её росте стенд пересоздаёт набор при запуске (DEMO_AUTO_UPGRADE). */
export const DEMO_VERSION = 5;

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inn10(prefix: string, r: () => number): string {
  const d = [...prefix].map(Number);
  while (d.length < 9) d.push(Math.floor(r() * 10));
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  d.push((w.reduce((a, k, i) => a + k * d[i]!, 0) % 11) % 10);
  return d.join('');
}

const ROLES = [
  { key: 'kam', name: 'КАМ', description: 'Ведёт переговорные кампании по закреплённым сетям.', permissions: ['CAMPAIGN_EDIT', 'ANALYTICS'], scope: 'OWN' },
  { key: 'head', name: 'Руководитель КАМ', description: 'Руководит группой КАМ, согласует кампании подчинённых.', permissions: ['CAMPAIGN_EDIT', 'CAMPAIGN_EDIT_SUBORDINATES', 'APPROVE', 'ANALYTICS'], scope: 'SUBORDINATES' },
  { key: 'national', name: 'Национальный руководитель', description: 'Руководитель направления аптечных сетей.', permissions: ['CAMPAIGN_EDIT_SUBORDINATES', 'APPROVE', 'ANALYTICS'], scope: 'SUBORDINATES' },
  { key: 'cfo', name: 'Финансовый директор', description: 'Согласует крупные инвестиции в сети.', permissions: ['APPROVE', 'ANALYTICS'], scope: 'ALL' },
  { key: 'controller', name: 'Финансовый контролёр', description: 'Проверяет экономику разовых акций.', permissions: ['APPROVE', 'ANALYTICS'], scope: 'ALL' },
  { key: 'brand', name: 'Бренд-менеджер', description: 'Видит затраты и результаты по своим брендам.', permissions: ['ANALYTICS'], scope: 'BRANDS' },
  { key: 'admin', name: 'Администратор', description: 'Пользователи, роли, справочники и маршруты.', permissions: ['ADMIN'], scope: 'ALL' },
] as const;

const USERS: { email: string; name: string; roles: string[]; manager?: string; brands?: string[] }[] = [
  { email: 'olga.morozova', name: 'Ольга Морозова', roles: ['national'] },
  { email: 'elena.sokolova', name: 'Елена Соколова', roles: ['head'], manager: 'olga.morozova' },
  { email: 'sergey.volkov', name: 'Сергей Волков', roles: ['head'], manager: 'olga.morozova' },
  { email: 'anna.smirnova', name: 'Анна Смирнова', roles: ['kam'], manager: 'elena.sokolova' },
  { email: 'dmitry.petrov', name: 'Дмитрий Петров', roles: ['kam'], manager: 'elena.sokolova' },
  { email: 'maria.kuznetsova', name: 'Мария Кузнецова', roles: ['kam'], manager: 'elena.sokolova' },
  { email: 'ilya.ivanov', name: 'Илья Иванов', roles: ['kam'], manager: 'sergey.volkov' },
  { email: 'alexey.novikov', name: 'Алексей Новиков', roles: ['kam'], manager: 'sergey.volkov' },
  { email: 'tatiana.lebedeva', name: 'Татьяна Лебедева', roles: ['kam'], manager: 'sergey.volkov' },
  { email: 'igor.vasiliev', name: 'Игорь Васильев', roles: ['cfo'] },
  { email: 'natalia.popova', name: 'Наталья Попова', roles: ['controller'] },
  { email: 'ksenia.orlova', name: 'Ксения Орлова', roles: ['brand'], brands: ['Кардиовел', 'Венотон'] },
  { email: 'pavel.zaitsev', name: 'Павел Зайцев', roles: ['brand'], brands: ['Иммунорм', 'Респивент'] },
  { email: 'admin', name: 'Администратор стенда', roles: ['admin'] },
];

// Сеть, регионы, группа, КАМ, префикс ИНН (код региона).
const NETWORKS: [string, string[], 'fed' | 'reg', string, string][] = [
  ['Ригла', ['Москва', 'Московская область', 'Санкт-Петербург'], 'fed', 'anna.smirnova', '77'],
  ['АСНА', ['Москва', 'Московская область'], 'fed', 'anna.smirnova', '77'],
  ['Аптеки 36,6', ['Москва', 'Московская область', 'Санкт-Петербург'], 'fed', 'dmitry.petrov', '77'],
  ['Неофарм', ['Москва', 'Московская область'], 'fed', 'dmitry.petrov', '50'],
  ['Горздрав', ['Москва', 'Московская область'], 'fed', 'maria.kuznetsova', '77'],
  ['Эркафарм', ['Москва', 'Санкт-Петербург'], 'fed', 'maria.kuznetsova', '77'],
  ['Мелодия здоровья', ['Москва', 'Московская область'], 'fed', 'anna.smirnova', '50'],
  ['Будь Здоров', ['Москва', 'Московская область'], 'fed', 'dmitry.petrov', '77'],
  ['Озерки', ['Санкт-Петербург', 'Ленинградская область'], 'reg', 'maria.kuznetsova', '78'],
  ['Магнит Аптека', ['Краснодарский край', 'Ростовская область'], 'fed', 'ilya.ivanov', '23'],
  ['Апрель', ['Краснодарский край', 'Ростовская область'], 'fed', 'ilya.ivanov', '23'],
  ['Норман', ['Ростовская область'], 'reg', 'ilya.ivanov', '61'],
  ['Планета Здоровья', ['Пермский край', 'Свердловская область'], 'fed', 'alexey.novikov', '59'],
  ['Аптечная сеть 9-18', ['Пермский край'], 'reg', 'alexey.novikov', '59'],
  ['Живика', ['Свердловская область', 'Челябинская область'], 'reg', 'alexey.novikov', '66'],
  ['Мега Фарм', ['Челябинская область'], 'reg', 'alexey.novikov', '74'],
  ['Вита', ['Самарская область', 'Оренбургская область'], 'fed', 'tatiana.lebedeva', '63'],
  ['Имплозия', ['Самарская область'], 'reg', 'tatiana.lebedeva', '63'],
  ['Фармленд', ['Республика Башкортостан'], 'reg', 'tatiana.lebedeva', '02'],
  ['Максавит', ['Нижегородская область', 'Ярославская область'], 'reg', 'tatiana.lebedeva', '52'],
  ['Фармакопейка', ['Новосибирская область'], 'reg', 'ilya.ivanov', '54'],
  ['Классика', ['Новосибирская область'], 'reg', 'ilya.ivanov', '54'],
  ['Губернские аптеки', ['Красноярский край'], 'reg', 'alexey.novikov', '24'],
  ['Монастырёв', ['Приморский край'], 'reg', 'tatiana.lebedeva', '25'],
];

const BRANDS = ['Кардиовел', 'Нейроспан', 'Гастрофикс', 'Иммунорм', 'Артросил', 'Респивент', 'Дермалайт', 'Венотон', 'Аллергофри', 'Пульмодил'];

const TYPES = [
  { key: 'annual', name: 'Годовые условия', split: 'QUARTER', days: 30 },
  { key: 'review', name: 'Пересмотр условий', split: 'QUARTER', days: 14 },
  { key: 'assort', name: 'Ассортиментное соглашение', split: 'QUARTER', days: 14 },
  { key: 'promo', name: 'Разовая акция', split: 'MONTH', days: 7 },
] as const;

const ORDER = ['PREPARATION', 'NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'];

export async function seedDemo(db: Db, opts: { password: string; domain?: string; reset?: boolean; today?: string; filesDir?: string }): Promise<{ clientId: string; users: number; campaigns: number }> {
  const domain = opts.domain ?? 'demo.truedata.tech';
  const r = rng(20271117);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const today = opts.today ?? todayIso();
  const day = (offset: number) => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400_000).toISOString().slice(0, 10);
  const passwordHash = await hashPassword(opts.password);

  return withTx(db, async (tx) => {
    const existing = (await tx.query<{ id: string }>('select id from kam.client where code=$1', [DEMO_CODE])).rows[0];
    if (existing) {
      if (!opts.reset) throw new Error('Демо-клиент уже есть. Запустите с --reset, чтобы пересоздать набор.');
      await purgeClient(tx, existing.id);
    }
    const clientId = existing?.id ?? randomUUID();
    if (!existing) await tx.query('insert into kam.client(id, code, name) values ($1,$2,$3)', [clientId, DEMO_CODE, 'Демо-фарм']);

    const roleIds: Record<string, string> = {};
    for (const role of ROLES) {
      roleIds[role.key] = randomUUID();
      await tx.query('insert into kam.business_role(client_id, id, name, description, permissions, scope) values ($1,$2,$3,$4,$5,$6)',
        [clientId, roleIds[role.key], role.name, role.description, role.permissions, role.scope]);
    }
    const brandIds: Record<string, string> = {};
    for (const b of BRANDS) {
      brandIds[b] = randomUUID();
      await tx.query('insert into kam.brand(client_id, id, name) values ($1,$2,$3)', [clientId, brandIds[b], b]);
    }
    const typeIds: Record<string, string> = {};
    let sort = 0;
    for (const t of TYPES) {
      typeIds[t.key] = randomUUID();
      await tx.query('insert into kam.campaign_type(client_id, id, name, period_split, control_days, sort_order) values ($1,$2,$3,$4,$5,$6)',
        [clientId, typeIds[t.key], t.name, t.split, t.days, sort++]);
    }
    const userIds: Record<string, string> = {};
    for (const u of USERS) {
      const email = `${u.email}@${domain}`;
      let id = (await tx.query<{ id: string }>('select id from kam.app_user where email=$1', [email])).rows[0]?.id;
      if (!id) {
        id = randomUUID();
        await tx.query('insert into kam.app_user(id, email, display_name, password_hash) values ($1,$2,$3,$4)', [id, email, u.name, passwordHash]);
      } else {
        await tx.query('update kam.app_user set display_name=$2, password_hash=$3, disabled=false, must_change_password=false where id=$1', [id, u.name, passwordHash]);
      }
      userIds[u.email] = id;
      await tx.query('insert into kam.membership(client_id, user_id) values ($1,$2)', [clientId, id]);
      for (const role of u.roles) await tx.query('insert into kam.user_business_role(client_id, user_id, role_id) values ($1,$2,$3)', [clientId, id, roleIds[role]]);
      for (const b of u.brands ?? []) await tx.query('insert into kam.user_brand(client_id, user_id, brand_id) values ($1,$2,$3)', [clientId, id, brandIds[b]]);
    }
    for (const u of USERS) {
      if (u.manager) {
        await tx.query(`insert into kam.user_manager(client_id, id, user_id, manager_id, valid) values ($1,$2,$3,$4, daterange('2025-01-01', null))`,
          [clientId, randomUUID(), userIds[u.email], userIds[u.manager]]);
      }
    }
    const groups = { fed: randomUUID(), reg: randomUUID() };
    await tx.query('insert into kam.network_group(client_id, id, name) values ($1,$2,$3), ($1,$4,$5)', [clientId, groups.fed, 'Федеральные сети', groups.reg, 'Региональные сети']);

    const nets: { id: string; name: string; kam: string; entities: string[] }[] = [];
    const usedInn = new Set<string>();
    for (const [name, regions, group, kam, prefix] of NETWORKS) {
      const id = randomUUID();
      await tx.query('insert into kam.network(client_id, id, name, regions, group_id) values ($1,$2,$3,$4,$5)', [clientId, id, name, regions, groups[group]]);
      const count = group === 'fed' ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2);
      const suffixes = ['', ' Центр', ' Регион', ' Плюс'];
      const forms = ['ООО', 'АО', 'ООО'];
      const entities: string[] = [];
      for (let i = 0; i < count; i++) {
        let inn = inn10(prefix, r);
        while (usedInn.has(inn)) inn = inn10(prefix, r);
        usedInn.add(inn);
        const le = randomUUID();
        await tx.query('insert into kam.legal_entity(client_id, id, network_id, inn, name) values ($1,$2,$3,$4,$5)',
          [clientId, le, id, inn, `${forms[i % forms.length]} «${name}${suffixes[i]}»`]);
        entities.push(le);
      }
      await tx.query(`insert into kam.kam_assignment(client_id, id, user_id, network_id, valid) values ($1,$2,$3,$4, daterange('2025-01-01', null))`,
        [clientId, randomUUID(), userIds[kam], id]);
      nets.push({ id, name, kam, entities });
    }

    // Кампании ---------------------------------------------------------------
    let number = 0;
    let campaigns = 0;
    const made: { id: string; net: (typeof nets)[number]; type: string; from: string; to: string; stage: string; owner: string; times: Date[] }[] = [];
    const insertCampaign = async (o: { net: (typeof nets)[number]; type: keyof typeof typeIds; title: string; from: string; to: string; control: string; stage: string; created: string; cancel?: string }) => {
      const id = randomUUID();
      number += 1;
      campaigns += 1;
      const owner = userIds[o.net.kam]!;
      // Этапы проходятся по порядку с правдоподобными датами между созданием и сегодняшним днём.
      const target = o.stage === 'CANCELLED' ? 'NEGOTIATION' : o.stage;
      const steps = ORDER.slice(0, ORDER.indexOf(target) + 1);
      const start = Date.parse(o.created + 'T09:00:00Z');
      const end = Math.min(Date.parse(today + 'T18:00:00Z'), start + steps.length * 12 * 86400_000);
      const span = Math.max(1, end - start);
      const times = steps.map((_, i) => new Date(start + (span * i) / Math.max(1, steps.length) + Math.floor(r() * 4) * 3600_000));
      const stageAt = o.stage === 'CANCELLED' ? new Date(end) : times[times.length - 1]!;
      await tx.query(
        `insert into kam.campaign(client_id, id, number, network_id, type_id, title, period_from, period_to, control_date, owner_id, stage, stage_changed_at,
                                  cancel_reason, created_by, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$10,$14,$12)`,
        [clientId, id, number, o.net.id, typeIds[o.type], o.title, o.from, o.to, o.control, owner, o.stage, stageAt, o.cancel ?? null, times[0]]);
      for (const le of o.net.entities) await tx.query('insert into kam.campaign_legal_entity(client_id, campaign_id, legal_entity_id) values ($1,$2,$3)', [clientId, id, le]);
      const ev = (kind: string, at: Date, actor: string, from: string | null, to: string | null, comment: string | null = null) =>
        tx.query('insert into kam.campaign_event(client_id, id, campaign_id, kind, from_stage, to_stage, comment, actor, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [clientId, randomUUID(), id, kind, from, to, comment, actor, at]);
      await ev('CREATED', times[0]!, owner, null, 'PREPARATION');
      for (let i = 1; i < steps.length; i++) {
        const to = steps[i]!;
        // Переход «Согласовано внутри» пишет демо-согласование (seedApprovals) — от имени последнего согласующего.
        if (to === 'APPROVED') continue;
        await ev('STAGE', times[i]!, owner, steps[i - 1]!, to, null);
      }
      if (o.stage === 'CANCELLED') await ev('STAGE', stageAt, owner, 'NEGOTIATION', 'CANCELLED', o.cancel ?? null);
      made.push({ id, net: o.net, type: o.type, from: o.from, to: o.to, stage: o.stage, owner, times: o.stage === 'CANCELLED' ? [...times, stageAt] : times });
    };

    // Годовые условия 2027: основной поток переговоров в ноябре.
    const annual2027 = ['PREPARATION', 'NEGOTIATION', 'NEGOTIATION', 'NEGOTIATION', 'APPROVAL', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL'];
    for (const net of nets) {
      const stage = pick(annual2027);
      // Контрольная дата — 1 декабря; часть кампаний не успевает, у части дата уже прошла (просрочка).
      const control = r() < 0.18 ? day(-Math.floor(3 + r() * 10)) : '2026-12-01';
      await insertCampaign({ net, type: 'annual', title: 'Годовые условия 2027', from: '2027-01-01', to: '2027-12-31', control, stage, created: day(-Math.floor(20 + r() * 45)) });
    }
    // Годовые условия 2026: история прошлого периода.
    for (const net of nets) {
      await insertCampaign({ net, type: 'annual', title: 'Годовые условия 2026', from: '2026-01-01', to: '2026-12-31', control: '2025-12-01', stage: r() < 0.85 ? 'CLOSED' : 'FINAL', created: '2025-10-' + String(5 + Math.floor(r() * 20)).padStart(2, '0') });
    }
    // Разовые акции и пересмотры.
    const promos = [
      ['Зимняя акция: простуда и грипп', '2026-12-01', '2026-12-31'],
      ['Акция «Здоровое сердце»', '2027-02-01', '2027-02-28'],
      ['Весенняя аллергия', '2027-03-01', '2027-04-30'],
      ['Выкладка на кассовой зоне', '2027-01-15', '2027-03-15'],
    ] as const;
    const promoStages = ['PREPARATION', 'NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL', 'CANCELLED'];
    for (let i = 0; i < 22; i++) {
      const net = nets[(i * 7) % nets.length]!;
      const [title, from, to] = promos[i % promos.length]!;
      const stage = pick(promoStages);
      await insertCampaign({ net, type: 'promo', title, from, to, control: day(Math.floor(-5 + r() * 40)) < from ? day(Math.floor(-5 + r() * 40)) : from, stage,
        created: day(-Math.floor(5 + r() * 30)), cancel: stage === 'CANCELLED' ? 'Сеть отказалась от участия в акции.' : undefined });
    }
    for (let i = 0; i < 8; i++) {
      const net = nets[(i * 5 + 3) % nets.length]!;
      const isAssort = i % 2 === 1;
      await insertCampaign({ net, type: isAssort ? 'assort' : 'review', title: isAssort ? 'Расширение ассортимента 2027' : 'Пересмотр условий IV кв. 2026',
        from: isAssort ? '2027-01-01' : '2026-10-01', to: isAssort ? '2027-06-30' : '2026-12-31', control: isAssort ? '2026-12-10' : '2026-09-20',
        stage: isAssort ? pick(['PREPARATION', 'NEGOTIATION', 'APPROVAL']) : pick(['FINAL', 'CONFIRMED', 'CLOSED']), created: day(-Math.floor(10 + r() * 70)) });
    }
    await tx.query('insert into kam.campaign_counter(client_id, last_no) values ($1,$2)', [clientId, number]);
    await seedVersions(tx, { clientId, nets, made, brandIds, userIds, typeSplit: Object.fromEntries(TYPES.map((t) => [t.key, t.split])), filesDir: opts.filesDir ?? filesDir() });
    await seedRoutes(tx, { clientId, roleIds, typeIds, userIds, today });
    await seedApprovals(tx, { clientId, made, today });
    await seedCommunications(tx, { clientId, made, nets, userIds, today, filesDir: opts.filesDir ?? filesDir() });
    await writeSetting(tx, clientId, 'demo_version', DEMO_VERSION);
    return { clientId, users: USERS.length, campaigns };
  });
}

/** Полностью удаляет данные клиента (только для пересоздания демо-набора). Журнал обычно неизменяем — триггер временно отключается. */
async function purgeClient(tx: Tx, clientId: string) {
  await tx.query('alter table kam.audit_event disable trigger audit_event_no_update');
  await tx.query("select set_config('kam.purge', 'on', true)");
  await tx.query('update kam.campaign set confirmation_document_id=null, final_document_id=null, confirmed_version_id=null, final_version_id=null where client_id=$1', [clientId]);
  for (const t of ['email_outbox', 'notification', 'notification_pref', 'campaign_comment', 'activity', 'network_contact', 'approval_step', 'approval', 'route_rule', 'route_template', 'substitution', 'offer_version_document', 'offer_version_brand_note', 'offer_version_cell', 'offer_version', 'document', 'prior_period', 'client_setting', 'campaign_event', 'campaign_legal_entity', 'campaign', 'campaign_counter', 'kam_assignment', 'legal_entity', 'network', 'network_group',
    'user_brand', 'brand', 'user_manager', 'user_business_role', 'business_role', 'campaign_type', 'idempotency_request', 'audit_event', 'membership']) {
    await tx.query(`delete from kam.${t} where client_id = $1`, [clientId]);
  }
  await tx.query('alter table kam.audit_event enable trigger audit_event_no_update');
}

// Версии, прошлый период и документы демо-набора -----------------------------

const JUSTIFY = [
  'Рост инвестиций обеспечен расширением выкладки и участием сети в сезонной программе; ожидаемый оборот опирается на факт прошлого года.',
  'Сеть открывает новые аптеки в регионе — планируем рост оборота при сохранении ставки. Инвестиции по брендам перераспределены в пользу лидеров продаж.',
  'Условия сопоставимы с прошлым годом; увеличен бюджет на приоритетные бренды, по остальным — фиксированная ставка.',
  'Сеть не выполнила план прошлого года по части брендов: снижаем ставку и вводим ступенчатую шкалу за выполнение.',
];

async function seedVersions(tx: Tx, o: {
  clientId: string; nets: { id: string; name: string; kam: string }[];
  made: { id: string; net: { id: string; name: string }; type: string; from: string; to: string; stage: string; owner: string; times: Date[] }[];
  brandIds: Record<string, string>; userIds: Record<string, string>; typeSplit: Record<string, string>; filesDir: string;
}) {
  const r = rng(20261117);
  const between = (a: number, b: number) => a + r() * (b - a);
  const round = (v: number) => Math.round(v / 1000) * 1000;
  const brandNames = Object.keys(o.brandIds);
  // Прошлый период 2026: у каждой сети свой набор брендов и масштаб.
  const portfolio = new Map<string, { brand: string; q: { planInv: number; factInv: number; planTurn: number; factTurn: number }[] }[]>();
  for (const n of o.nets) {
    const big = ['Ригла', 'АСНА', 'Аптеки 36,6', 'Магнит Аптека', 'Планета Здоровья', 'Апрель', 'Горздрав', 'Неофарм'].includes(n.name);
    const count = big ? 5 + Math.floor(r() * 3) : 3 + Math.floor(r() * 3);
    const brands = [...brandNames].sort(() => r() - 0.5).slice(0, count);
    const rows = brands.map((brand) => {
      const base = big ? between(0.9, 3.2) : between(0.25, 1.1);
      const roiPlan = between(7, 14);
      const execution = between(0.72, 1.12);
      return {
        brand,
        q: [0.9, 1.05, 0.95, 1.1].map((season) => {
          const planInv = round(base * season * 1e6);
          const factInv = round(planInv * between(0.85, 1.08));
          const planTurn = round(planInv * roiPlan);
          return { planInv, factInv, planTurn, factTurn: round(planTurn * execution * between(0.95, 1.05)) };
        }),
      };
    });
    portfolio.set(n.id, rows);
    for (const row of rows) {
      for (const [i, q] of row.q.entries()) {
        await tx.query(
          `insert into kam.prior_period(client_id, network_id, brand_id, year, quarter, plan_investment, fact_investment, plan_turnover, fact_turnover, source)
           values ($1,$2,$3,2026,$4,$5,$6,$7,$8,'DEMO')`, [o.clientId, n.id, o.brandIds[row.brand], i + 1, q.planInv, q.factInv, q.planTurn, q.factTurn]);
      }
    }
  }

  const brandList = brandNames.map((name) => ({ id: o.brandIds[name]!, name }));
  for (const c of o.made) {
    const split = o.typeSplit[c.type] as Split;
    const periods = periodsFor(split, c.from, c.to);
    const prior = portfolio.get(c.net.id) ?? [];
    let count = 0;
    if (c.type === 'annual' && c.from.startsWith('2026')) count = 1;
    else if (c.stage === 'PREPARATION') count = r() < 0.3 ? 1 : 0;
    else if (c.stage === 'NEGOTIATION' || c.stage === 'CANCELLED') count = 1 + Math.floor(r() * 3);
    else count = 2 + Math.floor(r() * 2);
    if (!count) continue;
    // Основа версии: факт прошлого года с ростом; разовые акции — 1–2 бренда помесячно.
    const brands = c.type === 'annual' ? prior : prior.sort(() => r() - 0.5).slice(0, c.type === 'promo' ? 1 + Math.floor(r() * 2) : 2 + Math.floor(r() * 2));
    const growth = new Map(brands.map((b) => [b.brand, between(0.95, 1.3)]));
    const roiShift = new Map(brands.map((b) => [b.brand, between(0.88, 1.08)]));
    const stamp = (i: number) => {
      const t = c.times;
      const a = t[0]!.getTime();
      const b = (t[Math.min(t.length - 1, 2)] ?? t[0]!).getTime();
      return new Date(a + ((b - a) * (i + 1)) / (count + 1) + 3600_000);
    };
    for (let v = 1; v <= count; v++) {
      const step = 1 + (v - count) * 0.04; // ранние версии чуть скромнее, последняя — итоговая
      const cells: { brand_id: string; period_key: string; investment: number; turnover: number }[] = [];
      for (const b of brands) {
        const factYear = b.q.reduce((a, q) => a + q.factInv, 0);
        const roiFact = b.q.reduce((a, q) => a + q.factTurn, 0) / Math.max(1, factYear);
        for (const p of periods) {
          let inv: number;
          if (c.type === 'annual' && c.from.startsWith('2026')) {
            const q = b.q[Number(p.key.slice(6)) - 1]!;
            cells.push({ brand_id: o.brandIds[b.brand]!, period_key: p.key, investment: q.planInv, turnover: q.planTurn });
            continue;
          }
          if (split === 'QUARTER' && c.type === 'annual') inv = b.q[Number(p.key.slice(6)) - 1]!.factInv * growth.get(b.brand)! * step;
          else if (split === 'QUARTER') inv = (factYear / 4) * between(0.3, 0.6) * step;
          else inv = (factYear / 12) * between(0.15, 0.35) * step;
          const investment = round(inv);
          cells.push({ brand_id: o.brandIds[b.brand]!, period_key: p.key, investment, turnover: round(investment * roiFact * roiShift.get(b.brand)!) });
        }
      }
      if (!cells.length) continue;
      const id = randomUUID();
      const at = stamp(v - 1);
      const totalInv = cells.reduce((a, x) => a + x.investment, 0);
      const totalTurn = cells.reduce((a, x) => a + x.turnover, 0);
      await tx.query(
        `insert into kam.offer_version(client_id, id, campaign_id, number, periods, total_investment, total_turnover, justification, comment, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [o.clientId, id, c.id, v, JSON.stringify(periods), totalInv, totalTurn, v === count ? JUSTIFY[Math.floor(r() * JUSTIFY.length)]! : '',
          v === 1 ? 'Первое предложение сети.' : 'Учтены комментарии сети.', c.owner, at]);
      await tx.query(
        `insert into kam.offer_version_cell(client_id, version_id, brand_id, period_key, investment, turnover)
         select $1, $2, x.brand_id, x.period_key, x.investment, x.turnover from jsonb_to_recordset($3::jsonb) as x(brand_id uuid, period_key text, investment numeric, turnover numeric)`,
        [o.clientId, id, JSON.stringify(cells)]);
      // Файл предложения версии — в том же шаблоне, что скачивает КАМ.
      const fileName = `${c.net.name} — условия, версия ${v}.xlsx`;
      const buf = await versionTemplate({ title: `${c.net.name}: предложение, версия ${v}`, periods, brands: brandList.filter((b) => cells.some((x) => x.brand_id === b.id)), cells });
      const stored = await storeBuffer(o.filesDir, o.clientId, buf);
      const docId = randomUUID();
      await tx.query(
        `insert into kam.document(client_id, id, campaign_id, kind, file_name, mime, size_bytes, sha256, stage, uploaded_by, uploaded_at)
         values ($1,$2,$3,'OUR_OFFER',$4,$5,$6,$7,'NEGOTIATION',$8,$9)`,
        [o.clientId, docId, c.id, fileName, mimeOf(fileName), stored.size, stored.sha256, c.owner, at]);
      await tx.query('insert into kam.offer_version_document(client_id, version_id, document_id) values ($1,$2,$3)', [o.clientId, id, docId]);
      await tx.query(
        `insert into kam.campaign_event(client_id, id, campaign_id, kind, comment, payload, actor, at) values ($1,$2,$3,'VERSION_CREATED',$4,$5,$6,$7)`,
        [o.clientId, randomUUID(), c.id, v === 1 ? 'Первое предложение сети.' : 'Учтены комментарии сети.', JSON.stringify({ number: v, total_investment: totalInv, total_turnover: totalTurn }), c.owner, at]);
    }
  }
}

/** Пересоздаёт демо-набор, если сохранённая версия набора устарела. Пароль демо-пользователей не меняется. */
export async function upgradeDemo(db: Db, password: string, domain?: string): Promise<boolean> {
  const c = (await db.query<{ id: string; v: number | null }>(
    `select c.id, (s.settings->>'demo_version')::int v from kam.client c left join kam.client_setting s on s.client_id = c.id where c.code=$1`, [DEMO_CODE])).rows[0];
  if (!c || (c.v ?? 1) >= DEMO_VERSION) return false;
  await seedDemo(db, { password, reset: true, domain });
  return true;
}

// Маршруты и согласования демо-набора ------------------------------------------

async function seedRoutes(tx: Tx, o: { clientId: string; roleIds: Record<string, string>; typeIds: Record<string, string>; userIds: Record<string, string>; today: string }) {
  const day = (offset: number) => new Date(Date.parse(o.today + 'T00:00:00Z') + offset * 86400_000).toISOString().slice(0, 10);
  const templates = [
    { key: 'annual', name: 'Годовые условия', description: 'Руководитель КАМ → национальный руководитель → финансовый директор при инвестициях от 10 млн ₽.', def: false, tolInv: 2, tolTurn: 5,
      steps: [
        { title: 'Руководитель КАМ', assignee: { kind: 'MANAGER', level: 1 }, conditions: [], deadline_days: 3 },
        { title: 'Национальный руководитель', assignee: { kind: 'MANAGER', level: 2 }, conditions: [], deadline_days: 3 },
        { title: 'Финансовый директор', assignee: { kind: 'ROLE', role_id: o.roleIds.cfo, scoped: false }, conditions: [{ kind: 'INVESTMENT_GTE', amount: 10_000_000 }], deadline_days: 5 },
      ] },
    { key: 'promo', name: 'Разовая акция', description: 'Руководитель КАМ → финансовый контролёр при инвестициях от 250 тыс. ₽.', def: false, tolInv: 0, tolTurn: 0,
      steps: [
        { title: 'Руководитель КАМ', assignee: { kind: 'MANAGER', level: 1 }, conditions: [], deadline_days: 2 },
        { title: 'Финансовый контролёр', assignee: { kind: 'ROLE', role_id: o.roleIds.controller, scoped: false }, conditions: [{ kind: 'INVESTMENT_GTE', amount: 250_000 }], deadline_days: 3 },
      ] },
    { key: 'default', name: 'По умолчанию', description: 'Для типов без отдельного правила: согласует руководитель КАМ.', def: true, tolInv: 0, tolTurn: 0,
      steps: [{ title: 'Руководитель КАМ', assignee: { kind: 'MANAGER', level: 1 }, conditions: [], deadline_days: 3 }] },
  ];
  const ids: Record<string, string> = {};
  for (const t of templates) {
    ids[t.key] = randomUUID();
    await tx.query(
      `insert into kam.route_template(client_id, id, name, description, is_default, steps, tolerance_investment_pct, tolerance_turnover_pct) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.clientId, ids[t.key], t.name, t.description, t.def, JSON.stringify(t.steps), t.tolInv, t.tolTurn]);
  }
  await tx.query('insert into kam.route_rule(client_id, id, priority, template_id, campaign_type_id) values ($1,$2,10,$3,$4), ($1,$5,20,$6,$7)',
    [o.clientId, randomUUID(), ids.annual, o.typeIds.annual, randomUUID(), ids.promo, o.typeIds.promo]);
  // Финансовый директор в отпуске — его шаги решает финансовый контролёр.
  await tx.query(`insert into kam.substitution(client_id, id, user_id, deputy_id, valid, comment, created_by) values ($1,$2,$3,$4, daterange($5::date, $6::date, '[]'), $7, $3)`,
    [o.clientId, randomUUID(), o.userIds['igor.vasiliev'], o.userIds['natalia.popova'], day(-2), day(9), 'Отпуск']);
}

const APPROVE_NOTES = ['', '', 'Согласовано.', 'Ок, при условии выполнения плана по ключевым брендам.', 'Экономика в норме.', ''];
const REJECT_NOTES = [
  'Рост инвестиций выше факта прошлого года не обоснован. Снизьте ставку по брендам с невыполненным планом.',
  'ROI ниже прошлого года — пересмотрите распределение по брендам.',
  'Нужна ступенчатая шкала за выполнение плана, фиксированная ставка не подходит.',
];

async function seedApprovals(tx: Tx, o: { clientId: string; today: string; made: { id: string; stage: string; owner: string; times: Date[] }[] }) {
  const r = rng(20271201);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const now = Date.parse(o.today + 'T18:00:00Z');
  const ev = (campaignId: string, kind: string, at: Date, actor: string, extra: { from?: string; to?: string; comment?: string | null; payload?: unknown } = {}) =>
    tx.query('insert into kam.campaign_event(client_id, id, campaign_id, kind, from_stage, to_stage, comment, payload, actor, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [o.clientId, randomUUID(), campaignId, kind, extra.from ?? null, extra.to ?? null, extra.comment ?? null, extra.payload === undefined ? null : JSON.stringify(extra.payload), actor, at]);
  const after = ['APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'];

  const round = async (c: { id: string; owner: string }, v: { id: string; number: number; investment: number; turnover: number }, n: number,
    submittedAt: Date, mode: 'progress' | 'approved' | 'rejected', endAt: Date) => {
    const route = await computeRoute(tx, o.clientId, c.id, v.id, c.owner);
    if (route.steps.some((s) => s.included && s.error)) return null;
    const included = route.steps.filter((s) => s.included);
    const decideCount = mode === 'approved' ? included.length : mode === 'rejected' ? 1 + Math.floor(r() * included.length)
      : r() < 0.5 ? included.length - 1 : Math.floor(r() * included.length);
    const span = Math.max(3600_000, endAt.getTime() - submittedAt.getTime());
    const stamps = included.map((_, i) => new Date(submittedAt.getTime() + (span * (i + 1)) / (included.length + (mode === 'progress' ? 1 : 0)) - 1800_000));
    const status = mode === 'approved' ? 'APPROVED' : mode === 'rejected' ? 'REJECTED' : 'IN_PROGRESS';
    const approvalId = randomUUID();
    await tx.query(
      `insert into kam.approval(client_id, id, campaign_id, version_id, round, template_id, template_name, status, submitted_by, submitted_at, finished_at,
                                total_investment, total_turnover, tolerance_investment_pct, tolerance_turnover_pct)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [o.clientId, approvalId, c.id, v.id, n, route.template.id, route.template.name, status, c.owner, submittedAt, status === 'IN_PROGRESS' ? null : stamps[decideCount - 1],
        v.investment, v.turnover, route.template.tolerance_investment_pct, route.template.tolerance_turnover_pct]);
    await ev(c.id, 'APPROVAL_SUBMITTED', submittedAt, c.owner, { payload: { round: n, version: v.number, template: route.template.name, steps: included.length, skipped: route.steps.length - included.length } });
    let idx = 0;
    let last: { actor: string; at: Date } | null = null;
    for (const s of route.steps) {
      let st = 'SKIPPED', decidedBy: string | null = null, at: Date | null = null, comment: string | null = null, activated: Date | null = null, due: string | null = null;
      if (s.included) {
        const i = idx++;
        activated = i === 0 ? submittedAt : stamps[i - 1]!;
        if (i < decideCount) {
          const rejecting = mode === 'rejected' && i === decideCount - 1;
          st = rejecting ? 'REJECTED' : 'APPROVED';
          decidedBy = pick(s.candidates).id;
          at = stamps[i]!;
          comment = rejecting ? pick(REJECT_NOTES) : pick(APPROVE_NOTES) || null;
          last = { actor: decidedBy, at };
        } else if (i === decideCount && mode === 'progress') st = 'ACTIVE';
        else st = mode === 'rejected' ? 'CANCELLED' : 'WAITING';
        if (st !== 'WAITING' && st !== 'CANCELLED') due = addWorkdays(activated.toISOString().slice(0, 10), s.deadline_days);
        else activated = null;
      }
      await tx.query(
        `insert into kam.approval_step(client_id, id, approval_id, campaign_id, position, title, assignee_rule, condition_text, status, skip_reason, candidates, assign_note,
                                       deadline_days, activated_at, due_date, decided_by, decision_comment, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [o.clientId, randomUUID(), approvalId, c.id, s.position, s.title, s.assignee_rule, s.condition_text, st, s.skip_reason, s.candidates.map((x) => x.id), s.assign_note,
          s.deadline_days, activated, due, decidedBy, comment, at]);
      if (decidedBy && at) {
        await ev(c.id, 'APPROVAL_DECISION', at, decidedBy, { comment, payload: { round: n, step: s.position, title: s.title, decision: st === 'APPROVED' ? 'APPROVE' : 'REJECT', for_user: null } });
      }
    }
    return last;
  };

  for (const c of o.made) {
    const versions = (await tx.query<{ id: string; number: number; investment: number; turnover: number; created_at: Date }>(
      'select id, number, total_investment::float8 investment, total_turnover::float8 turnover, created_at from kam.offer_version where client_id=$1 and campaign_id=$2 order by number',
      [o.clientId, c.id])).rows;
    if (!versions.length) continue;
    const latest = versions[versions.length - 1]!;
    let n = 0;
    // Отклонённый раунд по предыдущей версии: у части кампаний в переговорах и дальше.
    if (versions.length >= 2 && (c.stage === 'NEGOTIATION' || after.includes(c.stage)) && r() < 0.45) {
      const prev = versions[versions.length - 2]!;
      const from = new Date(prev.created_at.getTime() + 3600_000);
      const to = new Date(Math.max(from.getTime() + 7200_000, latest.created_at.getTime() - 3600_000));
      const res = await round(c, prev, ++n, from, 'rejected', to);
      if (res) {
        await ev(c.id, 'STAGE', from, c.owner, { from: 'NEGOTIATION', to: 'APPROVAL' });
        await ev(c.id, 'STAGE', res.at, res.actor, { from: 'APPROVAL', to: 'NEGOTIATION', comment: 'Отклонено согласующим — нужна новая версия.' });
      } else n--;
    }
    if (!after.includes(c.stage)) continue;
    const t = c.times;
    const submittedAt = t[2] ?? t[t.length - 1]!;
    if (submittedAt.getTime() < latest.created_at.getTime()) continue;
    if (c.stage === 'APPROVAL') {
      await round(c, latest, ++n, submittedAt, 'progress', new Date(now));
    } else {
      const res = await round(c, latest, ++n, submittedAt, 'approved', t[3] ?? new Date(now));
      if (res) await ev(c.id, 'STAGE', t[3] ?? res.at, res.actor, { from: 'APPROVAL', to: 'APPROVED', comment: 'Все шаги маршрута согласованы.' });
    }
  }
}

// Контакты, активности, переписка, подтверждения сети и уведомления демо-набора ------------

const FIRST = ['Андрей', 'Марина', 'Олег', 'Светлана', 'Николай', 'Юлия', 'Павел', 'Ирина', 'Артём', 'Екатерина', 'Виктор', 'Анастасия'];
const LAST = ['Белов', 'Громова', 'Захаров', 'Киселёва', 'Лаптев', 'Миронова', 'Орлов', 'Панова', 'Рябов', 'Сафонова', 'Тихонов', 'Фомина'];
const POSITIONS = ['Директор по закупкам', 'Категорийный менеджер', 'Коммерческий директор', 'Руководитель маркетинга', 'Менеджер по работе с поставщиками'];
const PURPOSES = ['Обсудить ставку за выкладку и маркетинговый бюджет', 'Согласовать список брендов в программе', 'Обсудить встречное предложение сети', 'Уточнить план закупок по кварталам'];
const OUTCOMES = [
  'Сеть просит повысить ставку по лидерам продаж; готовы обсуждать при росте плана закупок.',
  'Договорились о ступенчатой шкале за выполнение плана; ждём расчёт от сети.',
  'Сеть согласна с перечнем брендов, вопрос по срокам выплат остаётся открытым.',
  'Получили встречное предложение по почте, передал на расчёт.',
  'Обсудили итоги прошлого года: невыполнение по двум брендам, сеть готова компенсировать выкладкой.',
];
const COMMENTS = [
  'Сеть настаивает на ставке выше прошлогодней — прошу посмотреть расчёт до встречи.',
  'По двум брендам план прошлого года не выполнен, рост инвестиций обоснован новыми аптеками.',
  'Подготовил сравнение с прошлым годом, приложил в документы.',
  'Ок, жду обновлённую версию после встречи с сетью.',
];

async function seedCommunications(tx: Tx, o: {
  clientId: string; today: string; filesDir: string;
  made: { id: string; net: { id: string; name: string }; stage: string; owner: string; times: Date[] }[];
  nets: { id: string; name: string; kam: string }[]; userIds: Record<string, string>;
}) {
  const r = rng(20271215);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const now = Date.parse(o.today + 'T12:00:00Z');
  const contacts = new Map<string, string[]>();
  for (const n of o.nets) {
    const ids: string[] = [];
    const count = 2 + Math.floor(r() * 2);
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const female = r() < 0.5;
      const first = pick(FIRST.filter((_, k) => (k % 2 === 1) === female));
      const last = pick(LAST.filter((_, k) => (k % 2 === 1) === female));
      await tx.query(
        `insert into kam.network_contact(client_id, id, network_id, name, position, phone, email, is_key, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [o.clientId, id, n.id, `${first} ${last}`, POSITIONS[(i + Math.floor(r() * 2)) % POSITIONS.length], `+7 9${Math.floor(10 + r() * 89)} ${Math.floor(100 + r() * 899)}-${Math.floor(10 + r() * 89)}-${Math.floor(10 + r() * 89)}`,
          '', i === 0, o.userIds[n.kam], new Date('2025-06-01T09:00:00Z')]);
      ids.push(id);
    }
    contacts.set(n.id, ids);
  }
  const ev = (campaignId: string, kind: string, at: Date, actor: string, comment: string | null, payload: unknown) =>
    tx.query('insert into kam.campaign_event(client_id, id, campaign_id, kind, comment, payload, actor, at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [o.clientId, randomUUID(), campaignId, kind, comment, JSON.stringify(payload), actor, at]);
  const active = ['NEGOTIATION', 'APPROVAL', 'APPROVED', 'CONFIRMED', 'FINAL', 'CLOSED'];
  const KL: Record<string, string> = { MEETING: 'Встреча', CALL: 'Звонок', EMAIL: 'Письмо' };
  for (const c of o.made) {
    if (!active.includes(c.stage) && c.stage !== 'CANCELLED') continue;
    const cs = contacts.get(c.net.id) ?? [];
    const start = c.times[1]?.getTime() ?? c.times[0]!.getTime();
    const end = Math.min(now, (c.times[3] ?? new Date(now)).getTime());
    const done = 1 + Math.floor(r() * 3);
    for (let i = 0; i < done; i++) {
      const at = new Date(start + ((end - start) * (i + 1)) / (done + 1));
      const kind = pick(['MEETING', 'CALL', 'CALL', 'EMAIL']);
      const outcome = pick(OUTCOMES);
      await tx.query(
        `insert into kam.activity(client_id, id, campaign_id, kind, at, contact_id, status, purpose, outcome, created_by, created_at, done_by, done_at)
         values ($1,$2,$3,$4,$5,$6,'DONE',$7,$8,$9,$5,$9,$5)`, [o.clientId, randomUUID(), c.id, kind, at, pick(cs), pick(PURPOSES), outcome, c.owner]);
      await ev(c.id, 'ACTIVITY_DONE', at, c.owner, outcome, { kind, kind_label: KL[kind], at: at.toISOString() });
    }
    if (['NEGOTIATION', 'APPROVAL'].includes(c.stage) && r() < 0.6) {
      const at = new Date(now + Math.floor(1 + r() * 10) * 86400_000 + 3600_000 * Math.floor(r() * 6));
      await tx.query(`insert into kam.activity(client_id, id, campaign_id, kind, at, contact_id, status, purpose, created_by) values ($1,$2,$3,'MEETING',$4,$5,'PLANNED',$6,$7)`,
        [o.clientId, randomUUID(), c.id, at, cs[0] ?? null, pick(PURPOSES), c.owner]);
    }
  }

  // Переписка: по кампаниям на согласовании — КАМ и исполнитель шага.
  const { rows: inApproval } = await tx.query<{ campaign_id: string; candidates: string[]; activated_at: Date; owner_id: string }>(
    `select s.campaign_id, s.candidates, s.activated_at, c.owner_id from kam.approval_step s join kam.campaign c on c.client_id = s.client_id and c.id = s.campaign_id
      where s.client_id=$1 and s.status='ACTIVE'`, [o.clientId]);
  const names = new Map((await tx.query<{ id: string; display_name: string }>('select id, display_name from kam.app_user where id = any($1::uuid[])', [Object.values(o.userIds)])).rows.map((x) => [x.id, x.display_name]));
  for (const s of inApproval) {
    const approver = s.candidates[0]!;
    const t0 = new Date(s.activated_at).getTime();
    await tx.query('insert into kam.campaign_comment(client_id, id, campaign_id, author_id, body, mentions, created_at) values ($1,$2,$3,$4,$5,$6,$7)',
      [o.clientId, randomUUID(), s.campaign_id, s.owner_id, `@${names.get(approver)} ${pick(COMMENTS.slice(0, 3))}`, [approver], new Date(t0 + 1800_000)]);
    if (r() < 0.5) {
      await tx.query('insert into kam.campaign_comment(client_id, id, campaign_id, author_id, body, mentions, created_at) values ($1,$2,$3,$4,$5,$6,$7)',
        [o.clientId, randomUUID(), s.campaign_id, approver, COMMENTS[3], [], new Date(t0 + 5 * 3600_000)]);
    }
  }

  // Подтверждение сетью и финальные условия — документы этапов 5 и 6.
  for (const c of o.made.filter((x) => ['CONFIRMED', 'FINAL', 'CLOSED'].includes(x.stage))) {
    const docs: [string, string, string, Date][] = [['NETWORK_CONFIRMATION', `${c.net.name} — подтверждение условий.xlsx`, 'confirmation_document_id', c.times[4] ?? c.times[c.times.length - 1]!]];
    if (c.stage !== 'CONFIRMED') docs.push(['FINAL_TERMS', `${c.net.name} — финальные условия.xlsx`, 'final_document_id', c.times[5] ?? c.times[c.times.length - 1]!]);
    for (const [kind, name, col, at] of docs) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(kind === 'FINAL_TERMS' ? 'Финальные условия' : 'Подтверждение');
      ws.addRow([kind === 'FINAL_TERMS' ? 'Финальные условия, согласованные с сетью' : 'Сеть подтверждает условия, согласованные внутри компании']);
      ws.addRow(['Сеть', c.net.name]);
      ws.addRow(['Дата', at.toISOString().slice(0, 10)]);
      const stored = await storeBuffer(o.filesDir, o.clientId, Buffer.from(await wb.xlsx.writeBuffer()));
      const id = randomUUID();
      await tx.query(
        `insert into kam.document(client_id, id, campaign_id, kind, file_name, mime, size_bytes, sha256, stage, uploaded_by, uploaded_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [o.clientId, id, c.id, kind, name, mimeOf(name), stored.size, stored.sha256, kind === 'FINAL_TERMS' ? 'CONFIRMED' : 'APPROVED', c.owner, at]);
      await tx.query(`update kam.campaign set ${col} = $3, ${col === 'final_document_id' ? 'finalized_at' : 'confirmed_at'} = $4 where client_id=$1 and id=$2`, [o.clientId, c.id, id, at]);
    }
  }
  // Подтверждённая и финальная версия — последняя версия кампании (после «Согласовано внутри» версии не меняются).
  for (const [col, doc] of [['confirmed_version_id', 'confirmation_document_id'], ['final_version_id', 'final_document_id']] as const) {
    await tx.query(
      `update kam.campaign c set ${col} = (select v.id from kam.offer_version v where v.client_id = c.client_id and v.campaign_id = c.id order by v.number desc limit 1)
        where c.client_id=$1 and c.${doc} is not null`, [o.clientId]);
  }

  // Центр уведомлений: шаги, которые ждут решения, и возвраты на доработку.
  const note = async (user: string, kind: string, campaignId: string, title: string, body: string, at: Date, read: boolean, actor: string | null) => {
    const id = randomUUID();
    await tx.query('insert into kam.notification(client_id, id, user_id, kind, campaign_id, title, body, actor_id, created_at, read_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [o.clientId, id, user, kind, campaignId, title, body, actor, at, read ? new Date(at.getTime() + 3600_000) : null]);
    const email = (await tx.query<{ email: string }>('select email from kam.app_user where id=$1', [user])).rows[0]!.email;
    await tx.query(`insert into kam.email_outbox(client_id, id, notification_id, user_id, to_email, subject, body, status, created_at) values ($1,$2,$3,$4,$5,$6,$7,'NO_CHANNEL',$8)`,
      [o.clientId, randomUUID(), id, user, email, `PharmaCheck · ${title}`, `${title}\n${body}`, at]);
  };
  const { rows: steps } = await tx.query<{ campaign_id: string; title: string; candidates: string[]; activated_at: Date; due_date: string; label: string; owner_id: string }>(
    `select s.campaign_id, s.title, s.candidates, s.activated_at, s.due_date::text due_date, n.name || ' — ' || c.title label, c.owner_id
       from kam.approval_step s join kam.campaign c on c.client_id = s.client_id and c.id = s.campaign_id join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where s.client_id=$1 and s.status='ACTIVE'`, [o.clientId]);
  for (const s of steps) {
    for (const u of s.candidates) {
      await note(u, 'STEP_ASSIGNED', s.campaign_id, `Нужно ваше решение: ${s.label}`, `Шаг «${s.title}», срок — ${s.due_date.split('-').reverse().join('.')}.`, new Date(s.activated_at), false, s.owner_id);
      await note(u, 'MENTION', s.campaign_id, `Вас упомянули в переписке: ${s.label}`, `${names.get(s.owner_id)}: посмотрите расчёт до решения.`, new Date(new Date(s.activated_at).getTime() + 1800_000), false, s.owner_id);
    }
  }
  const { rows: rejected } = await tx.query<{ campaign_id: string; owner_id: string; label: string; decided_by: string; title: string; decision_comment: string; decided_at: Date }>(
    `select distinct on (a.campaign_id) a.campaign_id, c.owner_id, n.name || ' — ' || c.title label, s.decided_by, s.title, s.decision_comment, s.decided_at
       from kam.approval a join kam.approval_step s on s.client_id = a.client_id and s.approval_id = a.id and s.status='REJECTED'
       join kam.campaign c on c.client_id = a.client_id and c.id = a.campaign_id join kam.network n on n.client_id = c.client_id and n.id = c.network_id
      where a.client_id=$1 and a.status='REJECTED' order by a.campaign_id, a.round desc`, [o.clientId]);
  for (const x of rejected) {
    await note(x.owner_id, 'RETURNED', x.campaign_id, `Возвращено на доработку: ${x.label}`, `${names.get(x.decided_by)}, шаг «${x.title}»: ${x.decision_comment}`, new Date(x.decided_at), r() < 0.6, x.decided_by);
  }
  // Просроченные шаги и контрольные даты, по которым демо-набор уже «уведомил», не дублируются планировщиком.
  await tx.query("update kam.approval_step set reminded_at = now(), overdue_notified_at = case when due_date < current_date then now() end where client_id=$1 and status='ACTIVE' and due_date <= current_date", [o.clientId]);
}
