-- Tool-call audit detail: identify the entity row a relay_write targeted or
-- changed, without storing the row values. logs stay service-role-only.
begin;

alter table logs.tool_calls add column if not exists table_name text;
alter table logs.tool_calls add column if not exists operation  text;
alter table logs.tool_calls add column if not exists row_id     uuid;

alter table logs.tool_calls drop constraint if exists tool_calls_operation_check;
alter table logs.tool_calls
  add constraint tool_calls_operation_check
  check (operation is null or operation in ('insert', 'update'));

create index if not exists tool_calls_row_lookup
  on logs.tool_calls (table_name, row_id, created_at desc);

notify pgrst, 'reload schema';

commit;
