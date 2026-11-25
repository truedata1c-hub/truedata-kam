-- ФИО в этой компании может отличаться от имени общей учётной записи.
alter table kam.membership add column display_name text
  check (char_length(btrim(display_name)) between 1 and 120);

create view kam.employee_profile as
select m.client_id, m.user_id as id, m.active, u.email,
       coalesce(m.display_name, u.display_name) as display_name,
       u.disabled, u.last_login_at, u.must_change_password, (u.password_hash is not null) as has_password
  from kam.membership m join kam.app_user u on u.id = m.user_id;
