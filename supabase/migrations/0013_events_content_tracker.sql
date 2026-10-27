-- Event Content Tracker: app.events now mirrors the House of 434 tracker.
-- Mapping: Event Title -> title, Event Date -> event_date, Hosted? -> hosted,
-- City / State -> city_state, Luma/Partiful Event Link -> event_url,
-- Speakers / Panelists -> speakers, Photos/Videos Drive Link -> media_url,
-- Cover Image / Poster Link -> cover_image_url, Other Notes -> notes.
--
-- Existing occurred_at/source_url/city values are copied to the new columns
-- before the old CRM, research, provenance, and ownership columns are dropped.

begin;

alter table app.events add column if not exists event_date date;
alter table app.events add column if not exists event_url  text;
alter table app.events add column if not exists city_state text;

update app.events
   set event_date = occurred_at::date
 where event_date is null and occurred_at is not null;

update app.events
   set event_url = source_url
 where event_url is null and source_url is not null;

update app.events
   set city_state = city
 where city_state is null and city is not null;

-- The old policy depends on classification, so remove it before the column.
drop policy if exists "read internal events" on app.events;

alter table app.events
  drop column if exists type,
  drop column if exists summary,
  drop column if exists occurred_at,
  drop column if exists company_id,
  drop column if exists tags,
  drop column if exists attendee_ids,
  drop column if exists investor_names,
  drop column if exists round,
  drop column if exists amount,
  drop column if exists classification,
  drop column if exists source,
  drop column if exists source_url,
  drop column if exists observed_at,
  drop column if exists captured_at,
  drop column if exists confidence,
  drop column if exists actor_user,
  drop column if exists actor_agent,
  drop column if exists external_source,
  drop column if exists external_source_id,
  drop column if exists owner_user_id,
  drop column if exists scope,
  drop column if exists city;

-- Every signed-in member may read every tracker row.
drop policy if exists "members read events" on app.events;
create policy "members read events" on app.events
  for select to authenticated using (true);

-- The tracker is read by date and by Luma/Partiful link.
create index if not exists events_event_date_idx on app.events (event_date desc);
create index if not exists events_event_url_idx on app.events (event_url);

comment on column app.events.event_date is
  'Event Content Tracker "Event Date"';
comment on column app.events.city_state is
  'Event Content Tracker "City / State"';
comment on column app.events.event_url is
  'Luma/Partiful event link from the tracker';

notify pgrst, 'reload schema';

commit;
