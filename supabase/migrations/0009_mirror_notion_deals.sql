-- Mirror the Notion "Running Deals" dashboard into app.companies so an agent
-- can keep Relay's companies table in step with the pipeline board (and, in
-- turn, the companies view). Scalar deal fields only: Deck and Data room are
-- Notion files whose API URLs are short-lived signed links, so notion_url is
-- the durable pointer back to the row.
--
-- status/stage/technology/vertical/industry are deliberately plain text with
-- no enum check. Notion select and status options evolve, and the Notion
-- connector writes whatever the board holds rather than coercing it to an
-- app-side enum; an enum here would reject a legitimate board value.
alter table app.companies
  add column if not exists status               text,   -- Tracking/Screening/Hold/Intro call/Preliminary/Pass/Due Diligence
  add column if not exists stage                text,   -- Pre-Seed/Seed
  add column if not exists technology           text,
  add column if not exists vertical             text,
  add column if not exists industry             text,
  add column if not exists deal_source          text,
  add column if not exists founder_name         text,
  add column if not exists founder_email        text,
  add column if not exists founder_linkedin     text,
  add column if not exists founder_age          integer,
  add column if not exists website              text,
  add column if not exists has_lead             boolean,
  add column if not exists domain_expertise     boolean,
  add column if not exists raise_amount         numeric,
  add column if not exists pre_money_valuation  numeric,
  add column if not exists founding_date        date,
  add column if not exists submission_date      date,
  add column if not exists target_close_date    date,
  add column if not exists deck_url             text,
  add column if not exists data_room_url        text,
  add column if not exists notion_page_id       text,
  add column if not exists notion_url           text;

-- One Relay row per Notion page: the sync's identity and dedupe key. The
-- partial index leaves ordinary hand-written companies (no Notion page) alone.
create unique index if not exists companies_notion_page_id_key
  on app.companies (notion_page_id)
  where notion_page_id is not null;

-- The companies view filters the pipeline by status.
create index if not exists companies_status_idx on app.companies (status);

-- confidence is the agent's 0-1 record-quality score. It stays optional on
-- insert (a mirrored board row is data, not an agent observation), but the
-- value is always in range whether supplied by an agent or a sync.
alter table app.companies drop constraint if exists companies_confidence_range;
alter table app.companies
  add constraint companies_confidence_range check (confidence >= 0 and confidence <= 1);
