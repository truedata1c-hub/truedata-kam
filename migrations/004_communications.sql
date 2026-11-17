-- Шаг 4: завершение цикла (подтверждение сетью, финальные условия), контакты и активности, переписка,
-- уведомления в системе и почтовый канал с очередью отправки (ТЗ §4, §7, §8.1).

alter table kam.campaign
  add column confirmation_document_id uuid,
  add column final_document_id uuid,
  add column confirmed_at timestamptz,
  add column finalized_at timestamptz,
  add column control_overdue_notified_at timestamptz,
  add foreign key (client_id, confirmation_document_id) references kam.document(client_id, id),
  add foreign key (client_id, final_document_id) references kam.document(client_id, id);

alter table kam.approval_step
  add column reminded_at timestamptz,
  add column overdue_notified_at timestamptz;

create table kam.network_contact (
  client_id    uuid not null,
  id           uuid not null,
  network_id   uuid not null,
  name         text not null check (char_length(name) between 1 and 120),
  position     text not null default '' check (char_length(position) <= 120),
  phone        text not null default '' check (char_length(phone) <= 40),
  email        text not null default '' check (char_length(email) <= 320),
  note         text not null default '' check (char_length(note) <= 500),
  is_key       boolean not null default false,
  archived_at  timestamptz,
  created_by   uuid not null references kam.app_user(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, network_id) references kam.network(client_id, id)
);
create index network_contact_network_idx on kam.network_contact (client_id, network_id);

create table kam.activity (
  client_id    uuid not null,
  id           uuid not null,
  campaign_id  uuid not null,
  kind         text not null check (kind in ('MEETING','CALL','EMAIL')),
  at           timestamptz not null,
  contact_id   uuid,
  status       text not null check (status in ('PLANNED','DONE','CANCELLED')),
  purpose      text not null default '' check (char_length(purpose) <= 1000),
  outcome      text not null default '' check (char_length(outcome) <= 2000),
  created_by   uuid not null references kam.app_user(id),
  created_at   timestamptz not null default now(),
  done_by      uuid references kam.app_user(id),
  done_at      timestamptz,
  primary key (client_id, id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id),
  foreign key (client_id, contact_id) references kam.network_contact(client_id, id)
);
create index activity_campaign_idx on kam.activity (client_id, campaign_id, at desc);

create table kam.campaign_comment (
  client_id    uuid not null,
  id           uuid not null,
  campaign_id  uuid not null,
  author_id    uuid not null references kam.app_user(id),
  body         text not null check (char_length(body) between 1 and 4000),
  mentions     uuid[] not null default '{}',
  created_at   timestamptz not null default now(),
  primary key (client_id, id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id)
);
create index campaign_comment_campaign_idx on kam.campaign_comment (client_id, campaign_id, created_at);

create table kam.notification (
  client_id    uuid not null,
  id           uuid not null,
  user_id      uuid not null references kam.app_user(id),
  kind         text not null check (char_length(kind) between 1 and 40),
  campaign_id  uuid,
  title        text not null check (char_length(title) between 1 and 300),
  body         text not null default '' check (char_length(body) <= 2000),
  actor_id     uuid references kam.app_user(id),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  primary key (client_id, id),
  foreign key (client_id, campaign_id) references kam.campaign(client_id, id)
);
create index notification_user_idx on kam.notification (client_id, user_id, created_at desc);
create index notification_unread_idx on kam.notification (client_id, user_id) where read_at is null;

-- Какие события пользователь получает письмом; строки нет — действует значение по умолчанию из каталога.
create table kam.notification_pref (
  client_id  uuid not null,
  user_id    uuid not null,
  kind       text not null,
  email      boolean not null,
  primary key (client_id, user_id, kind),
  foreign key (client_id, user_id) references kam.membership(client_id, user_id)
);

-- Очередь писем. Пока почтовый сервер не подключён, письма ждут со статусом NO_CHANNEL и не теряются.
create table kam.email_outbox (
  client_id        uuid not null,
  id               uuid not null,
  notification_id  uuid,
  user_id          uuid references kam.app_user(id),
  to_email         text not null,
  subject          text not null,
  body             text not null,
  status           text not null check (status in ('NO_CHANNEL','QUEUED','SENDING','SENT','RETRY','FAILED')),
  attempts         integer not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  primary key (client_id, id)
);
create index email_outbox_due_idx on kam.email_outbox (next_attempt_at) where status in ('QUEUED','RETRY');
