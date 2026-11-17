-- Схема PharmaCheck · Переговоры, шаг 1: клиенты, пользователи и сессии, конструктор ролей, оргструктура,
-- сети и юрлица, бренды, типы кампаний, кампании, история, журнал, идемпотентность.
-- Все клиентские ключи включают client_id: ссылка на сущность другого клиента невозможна на уровне БД.

create extension if not exists btree_gist;
create schema if not exists kam;

-- Клиенты и учётные записи -------------------------------------------------

create table kam.client (
  id          uuid primary key,
  code        text not null unique check (code ~ '^[A-Za-z0-9_-]{1,60}$'),
  name        text not null check (char_length(name) between 1 and 250),
  created_at  timestamptz not null default now()
);

create table kam.app_user (
  id                    uuid primary key,
  email                 text not null unique check (email = lower(email) and email like '%@%'),
  display_name          text not null check (char_length(display_name) between 1 and 120),
  -- Пользователь, пришедший только через сквозной вход платформы, может не иметь пароля модуля.
  password_hash         text,
  disabled              boolean not null default false,
  must_change_password  boolean not null default false,
  last_login_at         timestamptz,
  created_at            timestamptz not null default now()
);

-- Идентификатор пользователя в платформе: по нему сквозной вход находит учётную запись.
create table kam.external_identity (
  issuer      text not null,
  subject     text not null,
  user_id     uuid not null references kam.app_user(id),
  created_at  timestamptz not null default now(),
  primary key (issuer, subject)
);

create table kam.membership (
  client_id   uuid not null references kam.client(id),
  user_id     uuid not null references kam.app_user(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (client_id, user_id)
);

create table kam.session (
  token_hash  text primary key,
  user_id     uuid not null references kam.app_user(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  via         text not null default 'PASSWORD' check (via in ('PASSWORD','SSO'))
);
create index session_user_idx on kam.session(user_id);

create table kam.login_attempt (
  id     bigserial primary key,
  email  text not null,
  ip     text not null,
  ok     boolean not null,
  at     timestamptz not null default now()
);
create index login_attempt_email_idx on kam.login_attempt (email, at desc);
create index login_attempt_ip_idx on kam.login_attempt (ip, at desc);

-- Одноразовость токенов сквозного входа.
create table kam.sso_token_use (
  issuer      text not null,
  jti         text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz not null default now(),
  primary key (issuer, jti)
);

-- Конструктор ролей ---------------------------------------------------------

create table kam.business_role (
  client_id    uuid not null references kam.client(id),
  id           uuid not null,
  name         text not null check (char_length(name) between 1 and 120),
  description  text not null default '' check (char_length(description) <= 500),
  permissions  text[] not null check (permissions <@ array['CAMPAIGN_EDIT','CAMPAIGN_EDIT_SUBORDINATES','APPROVE','ANALYTICS','ADMIN']::text[]),
  scope        text not null check (scope in ('OWN','SUBORDINATES','ALL','BRANDS')),
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (client_id, id)
);
create unique index business_role_name_uq on kam.business_role (client_id, lower(name)) where not archived;

create table kam.user_business_role (
  client_id  uuid not null,
  user_id    uuid not null,
  role_id    uuid not null,
  primary key (client_id, user_id, role_id),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id),
  foreign key (client_id, role_id) references kam.business_role(client_id, id)
);

-- Оргструктура: руководитель сотрудника с датами действия, без пересечений.
create table kam.user_manager (
  client_id   uuid not null,
  id          uuid not null,
  user_id     uuid not null,
  manager_id  uuid not null,
  valid       daterange not null check (not isempty(valid) and lower(valid) is not null),
  primary key (client_id, id),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id),
  foreign key (client_id, manager_id) references kam.membership(client_id, user_id),
  check (user_id <> manager_id),
  exclude using gist (client_id with =, user_id with =, valid with &&)
);

-- Сети и юрлица ------------------------------------------------------------

create table kam.network_group (
  client_id  uuid not null references kam.client(id),
  id         uuid not null,
  name       text not null check (char_length(name) between 1 and 120),
  primary key (client_id, id)
);
create unique index network_group_name_uq on kam.network_group (client_id, lower(name));

create table kam.network (
  client_id   uuid not null references kam.client(id),
  id          uuid not null,
  name        text not null check (char_length(name) between 1 and 200),
  regions     text[] not null default '{}',
  group_id    uuid,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, group_id) references kam.network_group(client_id, id)
);
create unique index network_name_uq on kam.network (client_id, lower(name)) where not archived;

create table kam.legal_entity (
  client_id   uuid not null,
  id          uuid not null,
  network_id  uuid not null,
  inn         text not null check (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  name        text not null check (char_length(name) between 1 and 250),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, network_id) references kam.network(client_id, id),
  unique (client_id, inn)
);

-- Закрепление сотрудника за сетью с датами действия.
create table kam.kam_assignment (
  client_id   uuid not null,
  id          uuid not null,
  user_id     uuid not null,
  network_id  uuid not null,
  valid       daterange not null check (not isempty(valid) and lower(valid) is not null),
  primary key (client_id, id),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id),
  foreign key (client_id, network_id) references kam.network(client_id, id),
  exclude using gist (client_id with =, user_id with =, network_id with =, valid with &&)
);

-- Бренды и область видимости бренд-менеджера --------------------------------

create table kam.brand (
  client_id   uuid not null references kam.client(id),
  id          uuid not null,
  name        text not null check (char_length(name) between 1 and 120),
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (client_id, id)
);
create unique index brand_name_uq on kam.brand (client_id, lower(name)) where not archived;

create table kam.user_brand (
  client_id  uuid not null,
  user_id    uuid not null,
  brand_id   uuid not null,
  primary key (client_id, user_id, brand_id),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id),
  foreign key (client_id, brand_id) references kam.brand(client_id, id)
);

-- Типы кампаний -----------------------------------------------------------

create table kam.campaign_type (
  client_id      uuid not null references kam.client(id),
  id             uuid not null,
  name           text not null check (char_length(name) between 1 and 120),
  period_split   text not null check (period_split in ('MONTH','QUARTER','FOUR_MONTHS','WHOLE')),
  control_days   integer not null default 14 check (control_days between 0 and 365),
  archived       boolean not null default false,
  sort_order     integer not null default 0,
  primary key (client_id, id)
);
create unique index campaign_type_name_uq on kam.campaign_type (client_id, lower(name)) where not archived;

-- Кампании -----------------------------------------------------------------

create table kam.campaign_counter (
  client_id  uuid primary key references kam.client(id),
  last_no    integer not null default 0
);

create table kam.campaign (
  client_id         uuid not null,
  id                uuid not null,
  number            integer not null,
  network_id        uuid not null,
  type_id           uuid not null,
  title             text not null check (char_length(title) between 1 and 200),
  period_from       date not null,
  period_to         date not null,
  control_date      date not null,
  owner_id          uuid not null,
  stage             text not null check (stage in ('PREPARATION','NEGOTIATION','APPROVAL','APPROVED','CONFIRMED','FINAL','CANCELLED','CLOSED')),
  stage_changed_at  timestamptz not null default now(),
  cancel_reason     text,
  revision          integer not null default 1,
  created_by        uuid not null references kam.app_user(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (client_id, id),
  unique (client_id, number),
  foreign key (client_id, network_id) references kam.network(client_id, id),
  foreign key (client_id, type_id) references kam.campaign_type(client_id, id),
  foreign key (client_id, owner_id) references kam.membership(client_id, user_id),
  check (period_to >= period_from),
  check ((stage = 'CANCELLED') = (cancel_reason is not null))
);
create index campaign_network_idx on kam.campaign (client_id, network_id);
create index campaign_owner_idx on kam.campaign (client_id, owner_id);
create index campaign_stage_idx on kam.campaign (client_id, stage);

-- Юрлица сети, на которые распространятся условия кампании.
create table kam.campaign_legal_entity (
  client_id        uuid not null,
  campaign_id      uuid not null,
  legal_entity_id  uuid not null,
  primary key (client_id, campaign_id, legal_entity_id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id),
  foreign key (client_id, legal_entity_id) references kam.legal_entity(client_id, id)
);

-- История кампании, которую видят участники: этапы, решения, загрузки.
create table kam.campaign_event (
  client_id    uuid not null,
  id           uuid not null,
  campaign_id  uuid not null,
  kind         text not null check (char_length(kind) between 1 and 60),
  from_stage   text,
  to_stage     text,
  comment      text,
  payload      jsonb,
  actor        uuid references kam.app_user(id),
  at           timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id)
);
create index campaign_event_idx on kam.campaign_event (client_id, campaign_id, at desc);

-- Неизменяемый журнал и идемпотентность ------------------------------------

create table kam.audit_event (
  client_id    uuid not null references kam.client(id),
  id           uuid not null,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null,
  before       jsonb,
  after        jsonb,
  reason       text,
  actor        uuid not null references kam.app_user(id),
  request_id   text not null,
  recorded_at  timestamptz not null default now(),
  primary key (client_id, id)
);
create index audit_event_time_idx on kam.audit_event (client_id, recorded_at desc);
create index audit_event_entity_idx on kam.audit_event (client_id, entity_type, entity_id, recorded_at desc);

create function kam.audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_event is append-only';
end $$;
create trigger audit_event_no_update before update or delete on kam.audit_event
  for each row execute function kam.audit_immutable();

create table kam.idempotency_request (
  client_id      uuid not null references kam.client(id),
  actor_id       uuid not null references kam.app_user(id),
  key            uuid not null,
  method         text not null,
  path           text not null,
  body_hash      text not null,
  actor_roles    text[],
  result_status  integer not null,
  result_body    jsonb not null,
  result_etag    text,
  created_at     timestamptz not null default now(),
  primary key (client_id, actor_id, key)
);
