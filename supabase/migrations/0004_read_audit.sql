-- Read-audit columns for relay_read hardening: what was read, not the values.
--
-- Filter KEYS only, never values: an `email eq` value is PII and the keys are
-- enough for review. `flagged` marks bulk PII pulls (select includes email
-- and the result exceeds the review threshold) so they stand out in review.
-- service_role already holds all privileges on logs; members hold none.

alter table logs.tool_calls add column if not exists table_name text;
alter table logs.tool_calls add column if not exists columns text[];
alter table logs.tool_calls add column if not exists filter_keys text[];
alter table logs.tool_calls add column if not exists row_count int;
alter table logs.tool_calls add column if not exists flagged boolean not null default false;

create index if not exists tool_calls_flagged_created
  on logs.tool_calls (flagged, created_at desc);

notify pgrst, 'reload schema';
