-- Relay Scribe service actors and meeting ownership.
--
-- Background writes (the capture pipeline) previously had no identity: rows
-- carried emails only. This adds a service-actor registry so a meeting row can
-- be attributed to the Scribe service (UUID ownership), plus the organizer /
-- creator UUIDs resolved from the calendar event, with a generated owner.
--
-- relay.service_actors is a trusted, migration/service_role-only registry. It
-- is deliberately NOT exposed to PostgREST (not added to pgrst.db_schemas) and
-- has RLS with no policies, so no agent or member can read or write it. The
-- Tool Layer resolves the Scribe actor through app.scribe_service_actor_id().
--
-- The seeded actor_user_id is a synthetic service identity: it is never in
-- auth.users, no policy treats it as a member, and nothing else may claim it.
-- See Relay-notes for the service-identity record.

begin;

create schema if not exists relay;

create table if not exists relay.service_actors (
  name           text primary key,
  actor_user_id  uuid not null,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (name, actor_user_id)
);

insert into relay.service_actors (name, actor_user_id, enabled)
values ('scribe', '00000000-0000-4000-8000-0000000005c3', true)
on conflict (name) do nothing;

alter table relay.service_actors enable row level security;
revoke all on relay.service_actors from public, anon, authenticated;
grant all privileges on relay.service_actors to service_role;

alter table transcripts.meetings
  add column if not exists actor_agent       text,
  add column if not exists actor_user        uuid,
  add column if not exists organizer_user_id uuid,
  add column if not exists creator_user_id   uuid,
  add column if not exists disclosure_posted boolean not null default false;

alter table transcripts.meetings
  add column if not exists owner_user_id uuid
    generated always as (coalesce(organizer_user_id, creator_user_id)) stored;

-- Composite FK (not two single-column FKs): actor_agent='scribe' can never be
-- paired with another actor's UUID. MATCH FULL also forbids one column being
-- null while the other is set. ON UPDATE CASCADE keeps a rename cheap.
alter table transcripts.meetings drop constraint if exists meetings_actor_fk;
alter table transcripts.meetings
  add constraint meetings_actor_fk
    foreign key (actor_agent, actor_user)
    references relay.service_actors (name, actor_user_id)
    match full
    on update cascade;

create index if not exists meetings_owner_user     on transcripts.meetings (owner_user_id);
create index if not exists meetings_organizer_user on transcripts.meetings (organizer_user_id);

-- A terminal row is immutable, so any retry or reconciler pass is idempotent.
-- This is the only place that can enforce active -> partial|failed globally;
-- the Tool Layer's reconciler relies on it instead of trusting itself.
create or replace function transcripts.enforce_meeting_status()
returns trigger language plpgsql as $$
begin
  if old.status in ('completed','partial','failed','skipped')
     and new.status <> old.status then
    raise exception 'meeting status % is terminal; cannot change to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists meetings_status_transition on transcripts.meetings;
create trigger meetings_status_transition
  before update on transcripts.meetings
  for each row execute function transcripts.enforce_meeting_status();

-- Scribe service identity for the ingest path (keeps `relay` off PostgREST).
create or replace function app.scribe_service_actor_id()
returns uuid language sql stable security definer set search_path = ''
as $$ select actor_user_id from relay.service_actors where name = 'scribe' and enabled $$;
revoke execute on function app.scribe_service_actor_id() from public, anon, authenticated;
grant execute on function app.scribe_service_actor_id() to service_role;

-- email -> uuid. Service-role only. auth.users IS the teammate boundary:
-- sign-ups are restricted by hook_restrict_signup_domain, so a confirmed row
-- here is already an allowed teammate. allowed_domains remains available for a
-- caller that wants an extra narrowing, but Relay passes none — a second list
-- drifted from the auth gate and silently dropped teammates whose domain was
-- allowed at sign-up but missing from the env var.
-- Confirmed, non-deleted, non-banned users only.
create or replace function app.member_by_email(candidate text, allowed_domains text[] default null)
returns uuid language sql stable security definer set search_path = ''
as $$
  select u.id from auth.users u
  where lower(u.email) = lower(trim(candidate))
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now())
    and (allowed_domains is null
         or split_part(lower(u.email), '@', 2) = any (allowed_domains))
  limit 1
$$;
revoke execute on function app.member_by_email(text, text[]) from public, anon, authenticated;
grant execute on function app.member_by_email(text, text[]) to service_role;

-- Backfill the live-test rows (null organizer/creator/actor before this ran).
update transcripts.meetings
   set organizer_user_id = app.member_by_email(organizer_email),
       creator_user_id   = app.member_by_email(invited_by)
 where (organizer_user_id is null and organizer_email is not null)
    or (creator_user_id is null and invited_by is not null);
update transcripts.meetings
   set actor_agent = 'scribe', actor_user = app.scribe_service_actor_id()
 where actor_agent is null and actor_user is null;

commit;

notify pgrst, 'reload schema';
