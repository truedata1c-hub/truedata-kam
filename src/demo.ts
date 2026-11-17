// Демонстрационный набор (ТЗ §1 п. 20): российские сети и КАМы из прототипа, оргструктура, роли, бренды,
// около 80 кампаний на разных этапах. Данные синтетические: ИНН сгенерированы с верным контрольным числом,
// бренды вымышлены. Генерация детерминирована, повторный запуск с --reset воспроизводит тот же набор.

import { randomUUID } from 'node:crypto';
import type { Db, Tx } from './db.js';
import { withTx } from './db.js';
import { hashPassword } from './auth.js';

export const DEMO_CODE = 'DEMO';

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
  { key: 'kam', name: 'КАМ', description: 'Ведёт переговорные кампании по закреплённым сетям.', permissions: ['CAMPAIGN_EDIT'], scope: 'OWN' },
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

export async function seedDemo(db: Db, opts: { password: string; domain?: string; reset?: boolean; today?: string }): Promise<{ clientId: string; users: number; campaigns: number }> {
  const domain = opts.domain ?? 'demo.truedata.tech';
  const r = rng(20271117);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
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
    const headOf = (kam: string) => USERS.find((u) => u.email === kam)!.manager!;
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
        const actor = to === 'APPROVED' ? userIds[headOf(o.net.kam)]! : owner;
        await ev('STAGE', times[i]!, actor, steps[i - 1]!, to, to === 'APPROVED' ? 'Согласовано в демо-наборе.' : null);
      }
      if (o.stage === 'CANCELLED') await ev('STAGE', stageAt, owner, 'NEGOTIATION', 'CANCELLED', o.cancel ?? null);
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
    return { clientId, users: USERS.length, campaigns };
  });
}

/** Полностью удаляет данные клиента (только для пересоздания демо-набора). Журнал обычно неизменяем — триггер временно отключается. */
async function purgeClient(tx: Tx, clientId: string) {
  await tx.query('alter table kam.audit_event disable trigger audit_event_no_update');
  for (const t of ['campaign_event', 'campaign_legal_entity', 'campaign', 'campaign_counter', 'kam_assignment', 'legal_entity', 'network', 'network_group',
    'user_brand', 'brand', 'user_manager', 'user_business_role', 'business_role', 'campaign_type', 'idempotency_request', 'audit_event', 'membership']) {
    await tx.query(`delete from kam.${t} where client_id = $1`, [clientId]);
  }
  await tx.query('alter table kam.audit_event enable trigger audit_event_no_update');
}
