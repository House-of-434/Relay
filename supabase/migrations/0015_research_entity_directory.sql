-- Research entity directory: the fields, review queue, and unified search
-- behind the background research capture. Applied out of band first; this
-- file keeps a fresh environment in step.
--
-- Idempotent, so it also converges an environment where an earlier draft ran.
-- `domain_key` is generated from domains[1], so the resolver must keep the
-- canonical primary domain first; the unique index therefore protects primary
-- domains only, and matching must also check every domain. `scope` (who can
-- read) stays separate from `classification` (how sensitive).

begin;

-- Host-only dedupe key: lower, no scheme, no /path, no :port, no ?query, no www.
create or replace function app.domain_key(value text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        split_part(
          split_part(regexp_replace(lower(btrim(value)), '^[a-z][a-z0-9+.-]*://', ''), '/', 1),
          ':', 1),
        '[?#].*$', ''),
      '^www\.', ''),
    '');
$$;

-- LinkedIn profile key: lower, no scheme, no regional/www subdomain, no
-- query/fragment, and only an /in/ path. Mirrors normalizeLinkedIn in
-- services/tool-layer/src/domain/entities.ts.
create or replace function app.linkedin_key(value text)
returns text
language sql
immutable
as $$
  with cleaned as (
    select regexp_replace(
             regexp_replace(
               regexp_replace(lower(btrim(value)), '^[a-z][a-z0-9+.-]*://', ''),
               '^www\.', ''),
             '[?#].*$', '') as text
  ),
  parts as (
    select
      nullif(split_part(text, '/', 1), '') as host,
      case when strpos(text, '/') = 0 then null else substr(text, strpos(text, '/')) end as path
    from cleaned
  )
  select case
    when host is null or path is null then null
    when host <> 'linkedin.com' and host not like '%.linkedin.com' then null
    when path !~ '^/in/[^/]+' then null
    else 'linkedin.com/in/' || (regexp_match(path, '^/in/([^/]+)'))[1]
  end
  from parts;
$$;

alter table app.companies
  add column if not exists domain_key text
    generated always as (app.domain_key(domains[1])) stored,
  add column if not exists location text,
  add column if not exists employee_count integer,
  add column if not exists company_type text,
  add column if not exists linkedin_url text;

alter table app.companies drop constraint if exists companies_employee_count_check;
alter table app.companies add constraint companies_employee_count_check
  check (employee_count is null or employee_count >= 0);

alter table app.companies drop constraint if exists companies_company_type_check;
alter table app.companies add constraint companies_company_type_check
  check (company_type is null or company_type in ('startup','fund','corporate','other'));

alter table app.people
  add column if not exists title text,
  add column if not exists location text,
  add column if not exists linkedin_url text,
  add column if not exists bio text,
  add column if not exists education text[] not null default '{}',
  add column if not exists links jsonb not null default '{}';

alter table app.people
  add column if not exists linkedin_key text
    generated always as (app.linkedin_key(linkedin_url)) stored;

alter table app.people alter column company_id drop not null;

-- Free-form tags were in an earlier draft of this directory; nothing consumes
-- them yet, so this also removes them from an environment that applied it.
alter table app.companies drop column if exists tags;
alter table app.people drop column if exists tags;

create index if not exists companies_location_idx on app.companies (location);
create index if not exists people_company_id_idx on app.people (company_id);
create index if not exists people_linkedin_key_idx
  on app.people (linkedin_key) where linkedin_key is not null;
create index if not exists people_location_idx on app.people (location);

-- Primary-domain uniqueness. If this fails, two existing rows share domains[1]:
--   select app.domain_key(domains[1]) as key, count(*)
--   from app.companies group by 1 having count(*) > 1;
create unique index if not exists companies_domain_key_key
  on app.companies (domain_key) where domain_key is not null;

create table if not exists app.entity_review (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('company','person')),
  status             text not null default 'pending'
                     check (status in ('pending','merged','dismissed')),
  incoming           jsonb not null,
  candidates         jsonb not null default '[]'::jsonb,
  reason             text not null,
  source_url         text,
  actor_user         uuid,
  actor_agent        text,
  resolved_entity_id uuid,
  created_at         timestamptz not null default now(),
  reviewed_by        uuid,
  reviewed_at        timestamptz
);

create index if not exists entity_review_pending_idx
  on app.entity_review (created_at desc) where status = 'pending';

alter table app.entity_review enable row level security;
revoke all on app.entity_review from public, anon, authenticated;
grant all on app.entity_review to service_role;

-- Unified Relay search: companies, people, and meeting snippets in one
-- ranking. Meeting snippets carry the mm:ss offset so the agent keeps the
-- timestamp the old search_meetings tool returned.
create or replace function app.search_relay(
  q        text,
  kinds    text[] default array['company','person','meeting'],
  max_rows integer default 20
)
returns table (
  kind        text,
  id          uuid,
  title       text,
  subtitle    text,
  snippet     text,
  score       real,
  source_url  text,
  observed_at timestamptz
)
language sql
stable
set search_path = public, extensions, app, transcripts
as $$
  with term as (
    select nullif(btrim(q), '') as q,
           greatest(1, least(coalesce(max_rows, 20), 50)) as lim,
           coalesce(kinds, array['company','person','meeting']) as kinds
  ),
  companies as (
    select 'company'::text as kind,
           c.id as id,
           c.name as title,
           nullif(concat_ws(' · ', c.industry, c.vertical, c.stage), '') as subtitle,
           left(coalesce(c.description, ''), 240) as snippet,
           greatest(
             similarity(c.name, t.q),
             case when c.domain_key = app.domain_key(t.q) then 1.0 else 0.0 end,
             similarity(coalesce(c.description, ''), t.q) * 0.6
           )::real as score,
           c.source_url as source_url,
           c.observed_at as observed_at
    from app.companies c, term t
    where t.q is not null
      and 'company' = any(t.kinds)
      and c.classification = 'internal'
      and (c.name % t.q or c.domain_key = app.domain_key(t.q) or c.description ilike '%' || t.q || '%')
  ),
  people as (
    select 'person'::text as kind,
           p.id as id,
           p.full_name as title,
           nullif(concat_ws(' · ', p.title, c.name), '') as subtitle,
           left(coalesce(p.bio, ''), 240) as snippet,
           greatest(
             similarity(p.full_name, t.q),
             similarity(coalesce(array_to_string(p.aliases, ' '), ''), t.q) * 0.8
           )::real as score,
           p.source_url as source_url,
           p.observed_at as observed_at
    from app.people p
    left join app.companies c on c.id = p.company_id, term t
    where t.q is not null
      and 'person' = any(t.kinds)
      and p.classification = 'internal'
      and (p.full_name % t.q
           or array_to_string(p.aliases, ' ') % t.q
           or p.full_name ilike '%' || t.q || '%')
  ),
  meetings as (
    select distinct on (m.id)
           'meeting'::text as kind,
           m.id as id,
           coalesce(m.title, m.native_id, 'Meeting') as title,
           nullif(concat_ws(' · ', m.platform, m.status), '') as subtitle,
           case
             when sm.start_seconds is null then sm.snippet
             else lpad((sm.start_seconds::int / 60)::text, 2, '0')
                  || ':' || lpad((sm.start_seconds::int % 60)::text, 2, '0')
                  || ' · ' || sm.snippet
           end as snippet,
           sm.rank as score,
           null::text as source_url,
           coalesce(m.actual_start, m.created_at) as observed_at
    from term t
    cross join lateral transcripts.search_meetings(t.q, t.lim) sm
    join transcripts.meetings m on m.id = sm.meeting_id
    where t.q is not null
      and 'meeting' = any(t.kinds)
    order by m.id, sm.rank desc
  )
  select * from (
    select * from companies
    union all
    select * from people
    union all
    select * from meetings
  ) results
  order by score desc
  limit (select lim from term);
$$;

revoke execute on function app.search_relay(text, text[], integer)
  from public, anon, authenticated;
grant execute on function app.search_relay(text, text[], integer)
  to service_role;

notify pgrst, 'reload schema';
commit;
