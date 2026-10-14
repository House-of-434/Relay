-- Relay Scribe transcripts: durable per-segment meeting records.
-- Written only by the capture pipeline through the Tool Layer ingest route;
-- agents hold read access only (see services/tool-layer/src/domain/permissions.ts).
-- Every transcript row is internal by definition, so there is no
-- classification column and no INTERNAL_ONLY_TABLES entry.

create schema if not exists transcripts;

create table transcripts.meetings (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('google_meet','zoom','teams')),
  instance_id text not null unique,
  calendar_event_id text,
  native_id text,
  title text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  status text not null default 'joining'
    check (status in ('joining','awaiting_admission','active',
                      'completed','partial','failed','skipped')),
  error text,
  organizer_email text,
  invited_by text,
  invitees jsonb not null default '[]',
  audio_path text,
  segment_count integer not null default 0,
  duration_seconds numeric,
  ingested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One native meeting live at most once: blocks double-arm races. Null
-- native_id rows never match (NULL ≠ NULL), so a URL-parse failure must
-- become a failed row before any join attempt, never a live row.
create unique index meetings_live_once
  on transcripts.meetings (platform, native_id)
  where status in ('joining','awaiting_admission','active');

create table transcripts.meeting_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references transcripts.meetings(id) on delete cascade,
  segment_key text not null,
  channel integer,
  speaker text,
  speaker_key text,
  source text,
  start_seconds numeric not null,
  end_seconds numeric not null,
  text text not null,
  language text,
  confidence numeric,
  is_final boolean not null default true,
  search_vector tsvector generated always as
    (to_tsvector('english', coalesce(text, ''))) stored,
  created_at timestamptz not null default now(),
  unique (meeting_id, segment_key)
);
create index on transcripts.meeting_segments (meeting_id, start_seconds);
create index meeting_segments_search on transcripts.meeting_segments using gin (search_vector);

alter table transcripts.meetings enable row level security;
alter table transcripts.meeting_segments enable row level security;

-- Every authenticated member may read every transcript. service_role
-- bypasses RLS; the Tool Layer is the real gate.
create policy "members read meetings"
  on transcripts.meetings for select to authenticated using (true);
create policy "members read segments"
  on transcripts.meeting_segments for select to authenticated using (true);

-- Grants mirror 0002_stores.sql: usage to authenticated+anon, select to
-- authenticated only, all to service_role.
grant usage on schema transcripts to authenticated, anon;
grant usage on schema transcripts to service_role;
grant select on all tables in schema transcripts to authenticated;
grant all privileges on all tables in schema transcripts to service_role;

create or replace function transcripts.search_meetings(q text, lim integer default 20)
returns table (meeting_id uuid, segment_id uuid, speaker text,
               snippet text, start_seconds numeric, rank real)
language sql stable as $$
  select m.id, s.id, s.speaker,
         ts_headline('english', s.text, plainto_tsquery('english', q),
                     'MaxFragments=2,MinWords=5,MaxWords=12'),
         s.start_seconds, s.score as rank
  from (
    select s.*,
           ts_rank(s.search_vector, plainto_tsquery('english', q)) as score
    from transcripts.meeting_segments s
    where s.search_vector @@ plainto_tsquery('english', q)
    order by score desc limit lim
  ) s
  join transcripts.meetings m on m.id = s.meeting_id
  order by s.score desc;
$$;
revoke execute on function transcripts.search_meetings from public, anon;
grant execute on function transcripts.search_meetings to service_role;

-- Surface the new schema to PostgREST: exact 0002 value + transcripts.
alter role authenticator set pgrst.db_schemas = 'public,app,logs,history,transcripts';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
