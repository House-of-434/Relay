-- Operational tool-call logging, attributable to the actor and agent.
--
-- 0002 created logs.tool_calls with a nullable conversation link, but the MVP
-- writes no history.conversations row (the harness keeps transcripts in
-- SQLite), so a tool call had no way to say who ran it. The Tool Layer is the
-- only writer and it knows the verified actor and the agent it served, so
-- attribute each row here. service_role already holds all privileges on logs;
-- members (authenticated/anon) hold none, so these rows stay operational-only.

alter table logs.tool_calls add column if not exists user_id uuid;
alter table logs.tool_calls add column if not exists agent text;

create index if not exists tool_calls_user_created
  on logs.tool_calls (user_id, created_at desc);

notify pgrst, 'reload schema';
