-- Представление действующего ответственного дополняется версиями, зафиксированными при подтверждении сетью
-- и финализации (миграция 005). Новые колонки добавляются в конец: create or replace сохраняет прежние.
create or replace view kam.campaign_with_owner as
select c.client_id, c.id, c.number, c.network_id, c.type_id, c.title,
       c.period_from, c.period_to, c.control_date, a.user_id as owner_id,
       c.stage, c.stage_changed_at, c.cancel_reason, c.revision,
       c.created_by, c.created_at, c.updated_at,
       c.confirmation_document_id, c.final_document_id, c.confirmed_at, c.finalized_at,
       c.control_overdue_notified_at,
       c.confirmed_version_id, c.final_version_id
  from kam.campaign c
  left join kam.kam_assignment a on a.client_id = c.client_id and a.network_id = c.network_id
                                 and a.valid @> current_date;
