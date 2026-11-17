-- Шаг 2: документы кампании, версии предложения с разбивкой бренд × период, прошлые периоды, настройки клиента.

-- Документы: файл хранится неизменяемо по SHA-256; удаление — только архив с причиной.
create table kam.document (
  client_id       uuid not null,
  id              uuid not null,
  campaign_id     uuid not null,
  kind            text not null check (kind in ('OUR_OFFER','NETWORK_OFFER','MEETING_MINUTES','CALCULATION','NETWORK_CONFIRMATION','SIGNED_CONTRACT','FINAL_TERMS','OTHER')),
  file_name       text not null check (char_length(file_name) between 1 and 255),
  mime            text not null,
  size_bytes      bigint not null check (size_bytes > 0),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  stage           text not null,
  comment         text not null default '' check (char_length(comment) <= 1000),
  uploaded_by     uuid not null references kam.app_user(id),
  uploaded_at     timestamptz not null default now(),
  archived_at     timestamptz,
  archived_by     uuid references kam.app_user(id),
  archive_reason  text,
  primary key (client_id, id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id),
  check ((archived_at is null) = (archive_reason is null))
);
create index document_campaign_idx on kam.document (client_id, campaign_id, uploaded_at desc);

-- Версия предложения: неизменяема после создания. Периоды (столбцы разбивки) фиксируются в версии.
create table kam.offer_version (
  client_id         uuid not null,
  id                uuid not null,
  campaign_id       uuid not null,
  number            integer not null check (number > 0),
  periods           jsonb not null,
  total_investment  numeric(18,2) not null check (total_investment >= 0),
  total_turnover    numeric(18,2) not null check (total_turnover >= 0),
  justification     text not null default '' check (char_length(justification) <= 5000),
  comment           text not null default '' check (char_length(comment) <= 2000),
  created_by        uuid not null references kam.app_user(id),
  created_at        timestamptz not null default now(),
  primary key (client_id, id),
  unique (client_id, campaign_id, number),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id)
);

create table kam.offer_version_cell (
  client_id    uuid not null,
  version_id   uuid not null,
  brand_id     uuid not null,
  period_key   text not null check (period_key ~ '^(ALL|\d{4}-(Q[1-4]|M(0[1-9]|1[0-2])|T[1-3]))$'),
  investment   numeric(18,2) not null check (investment >= 0 and investment < 1e14),
  turnover     numeric(18,2) not null check (turnover >= 0 and turnover < 1e14),
  primary key (client_id, version_id, brand_id, period_key),
  foreign key (client_id, version_id) references kam.offer_version(client_id, id),
  foreign key (client_id, brand_id) references kam.brand(client_id, id)
);

create table kam.offer_version_brand_note (
  client_id   uuid not null,
  version_id  uuid not null,
  brand_id    uuid not null,
  note        text not null check (char_length(note) between 1 and 1000),
  primary key (client_id, version_id, brand_id),
  foreign key (client_id, version_id) references kam.offer_version(client_id, id),
  foreign key (client_id, brand_id) references kam.brand(client_id, id)
);

create table kam.offer_version_document (
  client_id    uuid not null,
  version_id   uuid not null,
  document_id  uuid not null,
  primary key (client_id, version_id, document_id),
  foreign key (client_id, version_id) references kam.offer_version(client_id, id),
  foreign key (client_id, document_id) references kam.document(client_id, id)
);

-- Неизменяемость версий на уровне БД.
create function kam.version_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('kam.purge', true) = 'on' then return coalesce(new, old); end if;
  raise exception 'offer versions are immutable';
end $$;
create trigger offer_version_immutable before update or delete on kam.offer_version for each row execute function kam.version_immutable();
create trigger offer_version_cell_immutable before update or delete on kam.offer_version_cell for each row execute function kam.version_immutable();

-- План и факт прошлых периодов по сети, бренду и кварталу (этап 1 — загрузка из Excel; этап 2 — из PharmaCheck).
create table kam.prior_period (
  client_id         uuid not null,
  network_id        uuid not null,
  brand_id          uuid not null,
  year              integer not null check (year between 2000 and 2100),
  quarter           integer not null check (quarter between 1 and 4),
  plan_investment   numeric(18,2) check (plan_investment >= 0),
  fact_investment   numeric(18,2) check (fact_investment >= 0),
  plan_turnover     numeric(18,2) check (plan_turnover >= 0),
  fact_turnover     numeric(18,2) check (fact_turnover >= 0),
  source            text not null default 'IMPORT',
  loaded_by         uuid references kam.app_user(id),
  loaded_at         timestamptz not null default now(),
  primary key (client_id, network_id, brand_id, year, quarter),
  foreign key (client_id, network_id) references kam.network(client_id, id),
  foreign key (client_id, brand_id) references kam.brand(client_id, id)
);

-- Настройки клиента: пороги подсветок и служебные отметки (версия демо-набора).
create table kam.client_setting (
  client_id  uuid primary key references kam.client(id),
  settings   jsonb not null default '{}'
);
