-- Пока сеть свободна (закрепление закрыто, нового нет), её кампании остаются в ведении руководителей
-- последнего КАМа сети: last_owner_id — КАМ последнего начавшегося закрепления. У закреплённой сети — null.
create or replace view kam.campaign_with_owner as
select c.client_id, c.id, c.number, c.network_id, c.type_id, c.title,
       c.period_from, c.period_to, c.control_date, a.user_id as owner_id,
       c.stage, c.stage_changed_at, c.cancel_reason, c.revision,
       c.created_by, c.created_at, c.updated_at,
       c.confirmation_document_id, c.final_document_id, c.confirmed_at, c.finalized_at,
       c.control_overdue_notified_at,
       c.confirmed_version_id, c.final_version_id,
       case when a.user_id is null then (
         select p.user_id from kam.kam_assignment p
          where p.client_id = c.client_id and p.network_id = c.network_id and lower(p.valid) <= current_date
          order by lower(p.valid) desc limit 1) end as last_owner_id
  from kam.campaign c
  left join kam.kam_assignment a on a.client_id = c.client_id and a.network_id = c.network_id
                                 and a.valid @> current_date;
