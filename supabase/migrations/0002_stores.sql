-- Relay v0.1 user history and operational logging.
-- Review before running in Supabase project 434vc.
-- Together with 0001, this creates five tables across three schemas.
--
-- A conversation belongs to the signed-in user, not to the agent: `user_id`
-- is the authenticated Supabase subject and `agent` records which bot the user
-- was talking to. Messages live in a JSONB array because per-message rows are
-- unnecessary at this size; they can be split out later if a conversation
-- grows large or needs concurrent partial updates.
--
-- Tool activity is logged separately and is never part of conversation
-- history. Nothing here is written by a model.

create table history.conversations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  agent        text not null
               check (agent in ('scout','mercury','curator')),
  title        text,
  messages     jsonb not null default '[]'::jsonb
               check (jsonb_typeof(messages) = 'array'),
  status       text not null default 'idle'
               check (status in ('idle','running','failed')),
  error        text,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index conversations_user_updated on history.conversations (user_id, updated_at desc);

create table logs.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references history.conversations(id) on delete set null,
  tool            text not null,
  args_hash       text,
  ms              int,
  error           text,
  created_at      timestamptz not null default now()
);
create index tool_calls_created_at_desc on logs.tool_calls (created_at desc);
create index tool_calls_conversation on logs.tool_calls (conversation_id);

alter table history.conversations enable row level security;
alter table logs.tool_calls enable row level security;

-- A member reads only their own conversations and reports. There are
-- deliberately no authenticated INSERT/UPDATE/DELETE policies: conversation
-- history is written by the trusted server path, not by an agent.
create policy "read own conversations" on history.conversations
  for select to authenticated using (user_id = (auth.jwt() ->> 'sub')::uuid);

-- logs has no policies at all, so no member role can read operational logs.

-- PostgREST must expose these schemas for Relay and read-only web queries.
grant usage on schema app, logs, history to authenticated, anon;
grant usage on schema app, logs, history to service_role;
grant usage on schema extensions to authenticated, anon, service_role;

-- Members are read-only. The logs schema is intentionally not granted to
-- anon/authenticated and has no RLS policies.
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema app, history from public, anon, authenticated;
revoke all on all tables in schema logs from public, anon, authenticated;
grant select on all tables in schema app to authenticated;
grant select on all tables in schema history to authenticated;

-- The Tool Layer's service_role credential is the only elevated app writer.
grant all privileges on all tables in schema app, logs, history to service_role;

alter role authenticator set pgrst.db_schemas = 'public,app,logs,history';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';