-- Mirror the House of 434 Event Content Tracker into app.events. The tracker
-- carries website event content; the existing CRM fields stay in place.
-- Mapping: Event Title -> title, Event Date -> occurred_at, Hosted? -> hosted,
-- City / State -> city, Luma/Partiful Event Link -> source_url,
-- Speakers / Panelists -> speakers, Photos/Videos Drive Link -> media_url,
-- Cover Image / Poster Link -> cover_image_url, Other Notes -> notes.
--
-- hosted stays plain text: the tracker's options evolve, so no app-side enum
-- would reject a legitimate value.
alter table app.events
  add column if not exists hosted          text,
  add column if not exists city            text,
  add column if not exists speakers        text,
  add column if not exists media_url       text,
  add column if not exists cover_image_url text,
  add column if not exists notes           text;

comment on column app.events.hosted is
  'Event Content Tracker "Hosted?" value, e.g. hosted or co-hosted';
comment on column app.events.city is
  'Event Content Tracker "City / State"';
comment on column app.events.speakers is
  'Free-text speakers/panelists from the tracker';
comment on column app.events.media_url is
  'Photos/Videos Drive link from the tracker';
comment on column app.events.cover_image_url is
  'Cover image or poster link from the tracker';
comment on column app.events.notes is
  'Other notes from the tracker';

-- The tracker has no event type. New rows default to a gathering while the
-- existing explicit types remain valid.
alter table app.events alter column type set default 'gathering';

notify pgrst, 'reload schema';
