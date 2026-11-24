-- Одна сеть в одной компании может переходить между КАМами только без пересечения дат.
alter table kam.kam_assignment
  drop constraint kam_assignment_client_id_user_id_network_id_valid_excl,
  add constraint kam_assignment_network_period_excl
    exclude using gist (client_id with =, network_id with =, valid with &&);
