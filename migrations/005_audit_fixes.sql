-- Исправления по аудиту кода 20.11.2026: снимок финальной версии, разрядность итогов согласования,
-- устаревшие письма очереди, индексы для очистки служебных таблиц.

-- Версия, которую подтвердила сеть, и версия финальных условий: опора для выгрузки в PharmaCheck.
alter table kam.campaign
  add column confirmed_version_id uuid,
  add column final_version_id uuid,
  add foreign key (client_id, confirmed_version_id) references kam.offer_version(client_id, id),
  add foreign key (client_id, final_version_id) references kam.offer_version(client_id, id);

-- Уже подтверждённые и финализированные кампании: после «Согласовано внутри» новых версий не бывает, поэтому это последняя версия.
update kam.campaign c set confirmed_version_id = (
    select v.id from kam.offer_version v where v.client_id = c.client_id and v.campaign_id = c.id order by v.number desc limit 1)
  where c.confirmation_document_id is not null;
update kam.campaign c set final_version_id = (
    select v.id from kam.offer_version v where v.client_id = c.client_id and v.campaign_id = c.id order by v.number desc limit 1)
  where c.final_document_id is not null;

-- Итоги согласования — той же разрядности, что итоги версии: сумма разбивки не ломает отправку.
alter table kam.approval
  alter column total_investment type numeric(18,2),
  alter column total_turnover type numeric(18,2);

-- Письма, накопленные без почтового канала дольше срока актуальности, не отправляются задним числом.
alter table kam.email_outbox drop constraint email_outbox_status_check;
alter table kam.email_outbox add constraint email_outbox_status_check
  check (status in ('NO_CHANNEL','QUEUED','SENDING','SENT','RETRY','FAILED','EXPIRED'));

-- Индексы для регулярной очистки служебных таблиц.
create index session_expires_idx on kam.session (expires_at);
create index idempotency_request_created_idx on kam.idempotency_request (created_at);
create index notification_created_idx on kam.notification (created_at);
create index email_outbox_created_idx on kam.email_outbox (created_at);
create index login_attempt_at_idx on kam.login_attempt (at);
