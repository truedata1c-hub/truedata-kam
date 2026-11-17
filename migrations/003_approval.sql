-- Шаг 3: маршруты согласования (ТЗ §5), замещения (§3.2), отправки на согласование и решения.
-- Шаблон хранит шаги в jsonb (собираются в конструкторе); при отправке маршрут замораживается в approval_step
-- с вычисленными исполнителями, поэтому правка шаблона не меняет идущее согласование.

create table kam.route_template (
  client_id                 uuid not null references kam.client(id),
  id                        uuid not null,
  name                      text not null check (char_length(name) between 1 and 120),
  description               text not null default '' check (char_length(description) <= 500),
  is_default                boolean not null default false,
  steps                     jsonb not null check (jsonb_typeof(steps) = 'array'),
  -- Допуски для новой версии после «Согласовано внутри» (ТЗ §4): рост инвестиций и снижение оборота, %.
  tolerance_investment_pct  numeric(6,2) not null default 0 check (tolerance_investment_pct between 0 and 100),
  tolerance_turnover_pct    numeric(6,2) not null default 0 check (tolerance_turnover_pct between 0 and 100),
  archived                  boolean not null default false,
  revision                  integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (client_id, id),
  check (not (is_default and archived))
);
create unique index route_template_default_uq on kam.route_template (client_id) where is_default;
create unique index route_template_name_uq on kam.route_template (client_id, lower(name)) where not archived;

-- Правила выбора шаблона: первое подходящее по приоритету; иначе шаблон по умолчанию.
create table kam.route_rule (
  client_id         uuid not null,
  id                uuid not null,
  priority          integer not null check (priority between 1 and 1000),
  template_id       uuid not null,
  campaign_type_id  uuid,
  network_group_id  uuid,
  primary key (client_id, id),
  foreign key (client_id, template_id) references kam.route_template(client_id, id),
  foreign key (client_id, campaign_type_id) references kam.campaign_type(client_id, id),
  foreign key (client_id, network_group_id) references kam.network_group(client_id, id),
  check (campaign_type_id is not null or network_group_id is not null)
);

-- Замещение на даты: заместитель решает шаги замещаемого; в журнале «решил Б за А».
create table kam.substitution (
  client_id   uuid not null,
  id          uuid not null,
  user_id     uuid not null,
  deputy_id   uuid not null,
  valid       daterange not null check (not isempty(valid) and lower(valid) is not null and upper(valid) is not null),
  comment     text not null default '' check (char_length(comment) <= 500),
  created_by  uuid not null references kam.app_user(id),
  created_at  timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id),
  foreign key (client_id, deputy_id) references kam.membership(client_id, user_id),
  check (user_id <> deputy_id),
  exclude using gist (client_id with =, user_id with =, valid with &&)
);

create table kam.approval (
  client_id                 uuid not null,
  id                        uuid not null,
  campaign_id               uuid not null,
  version_id                uuid not null,
  round                     integer not null check (round > 0),
  template_id               uuid,
  template_name             text not null,
  status                    text not null check (status in ('IN_PROGRESS','APPROVED','REJECTED','WITHDRAWN','SUPERSEDED','CANCELLED')),
  submitted_by              uuid not null references kam.app_user(id),
  submitted_at              timestamptz not null default now(),
  submit_comment            text not null default '' check (char_length(submit_comment) <= 2000),
  finished_at               timestamptz,
  total_investment          numeric(16,2) not null,
  total_turnover            numeric(16,2) not null,
  tolerance_investment_pct  numeric(6,2) not null default 0,
  tolerance_turnover_pct    numeric(6,2) not null default 0,
  primary key (client_id, id),
  unique (client_id, campaign_id, round),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id),
  foreign key (client_id, version_id) references kam.offer_version(client_id, id),
  foreign key (client_id, template_id) references kam.route_template(client_id, id) on delete set null (template_id)
);
create unique index approval_active_uq on kam.approval (client_id, campaign_id) where status = 'IN_PROGRESS';

create table kam.approval_step (
  client_id         uuid not null,
  id                uuid not null,
  approval_id       uuid not null,
  campaign_id       uuid not null,
  position          integer not null check (position > 0),
  title             text not null,
  assignee_rule     text not null,
  condition_text    text not null default '',
  status            text not null check (status in ('WAITING','ACTIVE','APPROVED','REJECTED','SKIPPED','CANCELLED')),
  skip_reason       text,
  candidates        uuid[] not null default '{}',
  assign_note       text,
  deadline_days     integer not null check (deadline_days between 1 and 60),
  activated_at      timestamptz,
  due_date          date,
  decided_by        uuid references kam.app_user(id),
  decided_for       uuid references kam.app_user(id),
  decision_comment  text check (char_length(decision_comment) <= 2000),
  decided_at        timestamptz,
  primary key (client_id, id),
  unique (client_id, approval_id, position),
  foreign key (client_id, approval_id) references kam.approval(client_id, id)
);
create index approval_step_campaign_idx on kam.approval_step (client_id, campaign_id);
create index approval_step_active_idx on kam.approval_step using gin (candidates) where status = 'ACTIVE';
