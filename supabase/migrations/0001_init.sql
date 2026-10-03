-- Relay v0.1 shared House of 434 intelligence.
-- Review before running in Supabase project 434vc.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists app;
create schema if not exists logs;
create schema if not exists history;

-- APP ------------------------------------------------------------------
-- Only the Relay Tool Layer writes these tables. Actor and classification
-- fields are set by the server; the model cannot supply them. Records are
-- added intentionally and are visible to every signed-in member once written,
-- so there is no promotion or approval step. `classification` still gates
-- non-internal rows away from ordinary members.
create table app.companies (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  domains             text[] not null default '{}',
  description         text,
  embedding           extensions.vector(1536),
  classification      text not null default 'internal'
                      check (classification in ('internal','confidential','restricted')),
  source              text,
  source_url          text,
  observed_at         timestamptz not null default now(),
  captured_at         timestamptz not null default now(),
  confidence          float not null default 0.5,
  actor_user          uuid,
  actor_agent         text not null,
  external_source     text,
  external_source_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (external_source, external_source_id)
);

create table app.people (
  id                  uuid primary key default gen_random_uuid(),
  full_name           text not null,
  aliases             text[] not null default '{}',
  person_type         text[] not null default '{other}',
  company_id          uuid references app.companies(id) on delete set null,
  classification      text not null default 'internal'
                      check (classification in ('internal','confidential','restricted')),
  source              text,
  source_url          text,
  observed_at         timestamptz not null default now(),
  captured_at         timestamptz not null default now(),
  confidence          float not null default 0.5,
  actor_user          uuid,
  actor_agent         text not null,
  external_source     text,
  external_source_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (external_source, external_source_id)
);

create table app.events (
  id                  uuid primary key default gen_random_uuid(),
  type                text not null,
  title               text not null,
  summary             text,
  occurred_at         timestamptz,
  company_id          uuid references app.companies(id) on delete set null,
  tags                text[] not null default '{}',
  attendee_ids        uuid[] not null default '{}',
  investor_names      text[] not null default '{}',
  round               text,
  amount              numeric,
  classification      text not null default 'internal'
                      check (classification in ('internal','confidential','restricted')),
  source              text,
  source_url          text,
  observed_at         timestamptz not null default now(),
  captured_at         timestamptz not null default now(),
  confidence          float not null default 0.5,
  actor_user          uuid,
  actor_agent         text not null,
  external_source     text,
  external_source_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (external_source, external_source_id)
);

create index companies_domains_gin on app.companies using gin (domains);
create index companies_name_trgm on app.companies using gin (name extensions.gin_trgm_ops);
create index people_full_name_trgm on app.people using gin (full_name extensions.gin_trgm_ops);
create index people_person_type_gin on app.people using gin (person_type);
create index events_tags_gin on app.events using gin (tags);
create index events_occurred_at_desc on app.events (occurred_at desc);
create index events_company_id on app.events (company_id);

alter table app.companies enable row level security;
alter table app.people enable row level security;
alter table app.events enable row level security;

create policy "read internal companies" on app.companies
  for select to authenticated using (classification = 'internal');

create policy "read internal people" on app.people
  for select to authenticated using (classification = 'internal');

create policy "read internal events" on app.events
  for select to authenticated using (classification = 'internal');