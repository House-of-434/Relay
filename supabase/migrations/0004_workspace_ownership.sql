-- Per-user workspace ownership: stamped now, filtered later.
--
-- owner_user_id records which account owns a row; actor_user stays the
-- attribution of who wrote it. scope distinguishes a private workspace row
-- from an intentionally organization-level one. bot_id/thread_id on
-- conversations record which bot and thread a row came from.
--
-- Nothing filters on these columns yet. They are stamped now so a later
-- per-user filter and RLS do not need an inaccurate backfill.

alter table app.companies add column if not exists owner_user_id uuid;
alter table app.people add column if not exists owner_user_id uuid;
alter table app.events add column if not exists owner_user_id uuid;

alter table app.companies add column if not exists scope text not null default 'private' check (scope in ('private', 'org'));
alter table app.people add column if not exists scope text not null default 'private' check (scope in ('private', 'org'));
alter table app.events add column if not exists scope text not null default 'private' check (scope in ('private', 'org'));

alter table history.conversations add column if not exists bot_id uuid;
alter table history.conversations add column if not exists thread_id uuid;

-- Only when this project already holds real (pre-ship) rows: relabel them as
-- organization-scope, in this same step and before any new write. If the
-- tables hold only test data, leave them defaulting to 'private':
--
--   update app.companies set scope = 'org';
--   update app.people    set scope = 'org';
--   update app.events    set scope = 'org';

notify pgrst, 'reload schema';
