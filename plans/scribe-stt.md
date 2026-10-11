# Relay Scribe — STT integration plan (dev-ready)

Status: **approved, executing**. Builds on the shared-mailbox branch
`feature/shared-mailbox` (tip `ab573a3`: the four mailbox commits plus the BFF
fatal logger and the mailbox prompt-parity guard). `feature/meetings-agent`
was rebased onto the four mailbox commits and sits at `0d09e8d`, with the
offline Scribe WIP staged on top. All file:line references below were
re-verified against `0d09e8d`; the mailbox commits only shift lines below the
cited ranges in `mcp/agent-server.ts`. Rev: A–G fixes + nits (receipt order,
notice exits, capability-hygiene wording, SQL details).

## 0. Ordered execution (go/no-go first)

1. **VPS join test** — no repo code. Throwaway script on the VPS running the
   copied Vexa join code against real Meet (**anonymous and relay@ signed
   in**), Zoom, Teams. Check Workspace admin Meet settings. **If Meet
   admission fails, the plan changes shape.** Dev needs §12 — must be supplied
   before this starts. Pass/fail criteria: §8.
2. **0004 (no agent-enum change)** + `schema.test.ts` update +
   `transcripts.meetings` read-only shape + read grants + deny-tests.
3. BFF `safeEvent` fields + `authorizeIngest` + capability-bound ingest route
   + read/search tools + test pins + `third_party/vexa-capture` vendoring +
   offline golden tests + **roster-lookup report** (§6.7).
4. Rebase done (`0d09e8d` sits on the four mailbox commits). Confirm PR 0
   (capability retention) and PR 3 (send helper + known-member check)
   interfaces against the in-tree `server/mailbox-bff.ts` /
   `server/mailbox-notify.ts` — signatures are quoted in §6.4/§6.9; verify at
   build.
5. `server/scribe-monitor.ts` + worker endpoint skeleton + tests. **No role
   work.**
6. Worker pipeline (join → binder → STT client → spool → ingest); shared STT
   server with the §2.1 winner.
7. relay@ runbook (§7) + `.env.ingest` + `.env.scribe` + compose `scribe`
   service + `start-scribe.sh` + env docs + failure notices (§6.9).
8. VPS spike (§8 gates). Phase 2 (audio, viewer) only after.

## 1. Goal

Invite-triggered capture of Google Meet / Zoom / Teams audio, transcription
with a small local STT model, and durable per-segment transcripts in Supabase
that every teammate can read — including teammates who never invited Relay.

```
relay@ calendar (readonly)
        │  server/scribe-monitor.ts polls [now-24h, now+24h] via BFF internal route
        │  (retained capability + fresh actor assertion)
        ▼
  arm (idempotent: withCommandReceipt("scribe.arm", instance_id|event_start))
        │  monitor builds full descriptor, validates host, POSTs to worker
        ▼
scribe worker endpoint ──▶ join + capture ──▶ shared STT server
        │                                          │
        │  spool → ingest → Supabase transcripts.* │
        │                                          ▼
        └─ /status ◀── monitor reconciles armed-but-unnotified events;
                        on failed/completed sends relay@ notice
                        (scribe.notify receipt, once)
```

No agent runtime is involved at capture time. No Scribe role, no Scribe turns.

## 2. What we already know (do not re-run these spikes)

### 2.1 STT benchmark (real finance-style speech, laptop CPU)
| Model | RTF (warm) | RAM | Notes |
|---|---|---|---|
| whisper-small | ~0.55 | ~1.7 GB | best raw numbers, too heavy |
| Parakeet TDT 0.6B | ~0.05–0.06 | ~890 MB | strong accuracy, fast |
| Parakeet 110M | fastest | smallest | **garbles finance proper nouns** |
| Canary 180M Flash | ~0.15 | ~830 MB | best proper-noun accuracy, en/es/de/fr |

Decision: **head-to-head Canary 180M vs Parakeet TDT 0.6B on
`evals/fixtures/scribe/`** before finalizing (not 110M — already lost on
proper nouns). Measure **accuracy + image size + cold start + idle RAM**;
check for a lighter **Parakeet ONNX export** before ruling either in or out.
**First real capture 2026-10-10 (VPS, Oracle):** Parakeet TDT 0.6B int8 via
sherpa-onnx — model load ~3s, **RTF 0.137** (7.4s audio → 1.0s, 2 threads),
STT server steady **~1.1 GB** resident, browser (headless Chromium + Meet)
**~390–437 MB**. End-to-end authenticated Meet capture produced 13 coherent
segments over 96.5s of real speech (see §2.4). Quality note: strong on
ordinary speech, occasional proper-noun slips (heard "New York Central
Exchange" for "New York Stock Exchange"); Canary head-to-head still owed on
finance terms. Both finalists stay behind the same `stt.v1` adapter.
- **Canary license verified** (model card, 2026-10-10): **CC-BY-4.0,
  commercial use allowed**, attribution required. Runtime is **NeMo-only**
  (PyTorch; GPU-oriented — our CPU RTF ~0.15 was NeMo-on-CPU). No ONNX path
  published. The shared STT server (§6.6) is therefore a NeMo service unless
  Parakeet wins.
- **Reference text required**: one ~10-minute recording with crosstalk and
  real company names, hand-corrected. Without it the two models can only be
  compared against each other, not measured for accuracy (§8).

### 2.2 Vexa capture spike (done, keep the code)
Vexa Lite ran end-to-end on Meet/Zoom/Teams from this laptop. Proven:
- WebRTC remote-audio hook taps per-participant tracks (incl. Teams, which
  hides them from the DOM).
- Meet: per-channel named audio, no diarizer. Zoom: per-track + votes.
  Teams: mixed lane, pyannote cut-only segmentation + hints binder
  (measured `coverage-low ratio=0.25` live — attribution is provenance, not
  ground truth).
- Chat is not captured on any platform. Zoom/Teams passcodes must travel
  separately from the stored URL. Recurring meetings reuse native IDs across
  occurrences (identity must include occurrence).
- An OpenAI-compatible STT shim plugged into Vexa's `stt.v1` client and
  produced live segments. **The adapter interface is proven; only the
  checkpoint+server changes per finalist.**

### 2.3 Joinly spike (done, parked — do not resume without reason)Joinly v0.5.4 (MIT) tested via Docker (`ghcr.io/joinly-ai/joinly:latest`,
3.86 GB, container `joinly-test`, localhost-only).
- Joinly is **Linux-only by construction** (`/usr/bin/pulseaudio`,
  `/usr/bin/Xvfb`, `--ozone-platform=x11` hardcoded); native macOS runs wedge.
  Docker is its only supported path.
- MCP server has **no auth** and accepts client config: bind localhost-only,
  one trusted client. One meeting per instance → concurrency needs a slot pool.
- Teams join works end-to-end: knock → lobby → admitted → roster
  (`Relay Scribe` + organizer) → `get_transcript` live (empty with no speech).
- Meet anonymous join was refused with "You can't join this video call" on
  every attempt (pre-dates any lobby); incognito from a residential IP reached
  the pre-join screen on the same link. **Resolved 2026-10-10: VPS + signed-in
  relay@ profile reaches the authenticated lobby headlessly** ("Ready to
  join?", no name field, `?pli=1`) — the block was the anonymous/guest state
  under the   host's Workspace policy, not the datacenter IP. Still open:
  knock → admit → audio flowing (needs a live meeting + admitter).
- **Authenticated VPS join proven end-to-end 2026-10-10**: Vexa
  `authenticated: true` + persistent relay@ profile from the VPS —
  pre-join → knock → **admitted in ~5s** (user admitted promptly) → held
  30s → clean leave (`leave_result: true`). Full log + screenshots kept
  outside the repo. Audio capture not yet exercised (capture pipeline is
  step 6 work).
- Speaker attribution ("done" on their roadmap) was never verified — no human
  speech flowed during the test window.
- Park joinly. Revisit only if Vexa's binder loses a head-to-head on recorded
  fixtures. Test bench kept at
  `/var/folders/bb/_7c_tp6x5yz_39tq724bm5pc0000gn/T/opencode/joinly-test`
  (outside the repo; container currently stopped).

### 2.4 First authenticated live capture — proven end-to-end (2026-10-10)
VPS (Oracle, 2 vCPU / 11 GB), throwaway rig in `/tmp/scribe-vps-test`:
authenticated persistent-context join as relay@ → in-page PCM tap → Parakeet
int8 (sherpa-onnx) → segments.
- **Join → admit → capture → leave: all green.** Meet `ysf-ppyt-xzk`,
  admitted in ~5s, 96.5s of speech, **13 segments**, clean leave
  (`leave_result: true`).
- **Remote audio capture (our code, not Vexa's):** an init script installs
  the vendored WebRTC hook (mirrors remote tracks to `<audio>`), then a 16 kHz
  `AudioContext` + `ScriptProcessor` taps every `audio.srcObject` into one
  mono PCM buffer the driver drains over CDP every ~7s. Observed 6 audio
  elements, 3 mirrored remote tracks. This is the Meet capture path for the
  worker; Vexa's per-channel lane remains the alternative.
- **Resources:** Chrome **384–437 MB**, Parakeet server **~1.1 GB steady**,
  RTF **0.137** at 2 threads. Per-capture footprint ≈ **1.5 GB** on this box.
- **Store:** not yet written. The ingest route needs the Tool Layer running
  with `RELAY_INGEST_CAPABILITY` + a Supabase **service-role** key; the VPS
  prod stack doesn't carry the new route yet, and this env has no service-role
  key. **Only remaining MVP proof: segments → ingest route → `transcripts.*`
  → read back.**
- Artifacts (throwaway, not in repo):
  `capture-segments.json` (13 segments), `capture-resources.json`.
- First fixture committed: `evals/fixtures/scribe/meet-first-capture.json`
  (provenance + 13 segments, no participant names) with `evals/lib/scribe.ts`
  and an offline shape test.

### 2.5 Operational findings (2026-10-10, adopted)
- **Browser model: one persistent context, one page per meeting.** Not
  multiple Chrome processes on one profile dir (the OS locks the dir) and not
  a second browser per meeting. Copied profiles are a later option, each
  failing visibly if Google re-verifies. For now: **one capture at a time**;
  concurrency is step-later.
- **Concurrency cap: 2** (`RELAY_SCRIBE_MAX_CONCURRENT = 2`). A third
  meeting becomes a `failed` row with "at capacity" + failure notice (§6.9),
  never a silent drop.
- **Resource caveats:** the 11 GB is the whole VPS, shared by harness, BFF,
  Tool Layer, Scout's browser pool, web UI and up to three engines per bot.
  Measure the full stack idle → one capture → two. Test a 6+ participant
  meeting with video on and one screen-share (Chrome MEM grows with tiles);
  prefer disabling video decode if the join flags allow. **CPU is the tighter
  limit** (2 vCPU shared with STT + Chrome video decode) — run two
  simultaneous captures before assuming overlap is safe.
- **Store contract proof is next (§0 step 2b):** staging Supabase project,
  apply `0001`–`0004`, run the ingest route, read back. Prod service-role key
  stays only in `services/tool-layer/.env` on the prod host — never on a dev
  machine or the VPS test box. If a real key ever leaks to chat/ticket,
  rotate it.
- **Isolation rehearsal requirement:** before the showcase, run the store
  write locally first (catches missing-dir / schema-header bugs) and rehearse
  one real meeting end-to-end including a failure case (kick the bot) so the
  `failed`/`partial` row path is demonstrated.
- **Bug caught by the store proof (2026-10-11):** `revoke execute on function
  transcripts.search_meetings from public, anon;` stripped the default PUBLIC
  grant and nothing granted it back, so `service_role` got **42501 permission
  denied for function search_meetings**. Fixed in `0004` with
  `grant execute on function transcripts.search_meetings to service_role;`.
  Lesson recorded: validate grants by running **as `service_role`**
  (bypassrls), not as superuser, or this class is invisible.
- **Store proof on the VPS (existing relay DB) — DONE 2026-10-11.** Ran on the
  tool-layer host so the prod service-role key never left it. Ingest → Supabase
  → read-back → search all green: `POST /internal/transcripts` 200
  (`upserted:13`), wrong capability 401, idempotent re-post same `meeting_id`,
  `get_meeting_transcript` → `status=completed total=13 complete=true` with
  projected columns only (no `id`/`search_vector`), `search_meetings('Ferrari')`
  → 3 ranked hits with highlighted snippets + `start_seconds`, then the test
  row deleted. The `search_meetings` execute grant was applied to the live
  project first.

## 3. Locked decisions
| # | Decision | Source |
|---|---|---|
| 1 | Copy Vexa capture/binder/join code (Apache-2.0, headers + NOTICE), don't reinvent | user |
| 2 | STT finalists: Canary 180M vs Parakeet TDT 0.6B on fixtures (accuracy + image + cold start + idle RAM, hand-corrected reference); Canary CC-BY-4.0 verified, NeMo-only | feedback, incorporated |
| 3 | Single deterministic join path, **no agent recovery**. Failure → `failed` row (step + screenshot path); the failure rate measures selector drift and the fix is pulling upstream Vexa updates | feedback, incorporated |
| 4 | **No Scribe role, no scribe_* tools, no worker page endpoints.** Monitor calls the worker directly; agents read via §6.2 tools | feedback, incorporated |
| 5 | Everything persists in Supabase; meetings listed via `relay_read` on a read-only shape, segments via two bespoke tools; no transcript UI in MVP | user + feedback |
| 6 | Split capabilities: `RELAY_INGEST_CAPABILITY` in **`.env.ingest`** (tools + scribe); `RELAY_SCRIBE_WORKER_CAPABILITY` in **`.env.scribe`** (app + scribe). Never root `.env.secrets`, never the wrong service. Boot reads both into module variables and deletes them from `process.env` (PR 0 pattern) | feedback, incorporated |
| 7 | Single `instance_id` key (`singleEvents=true` ids are unique per occurrence); `recurringEventId` for series grouping only | feedback, incorporated |
| 8 | Trickled writes are fine; read tools show meeting `status`, in-progress = incomplete | feedback, incorporated |
| 9 | relay@ one-time sign-in (Workspace account), scopes as granted/verified/recorded (code only lists events); Meet joins **authenticated** via the Scribe profile, Zoom/Teams stay anonymous | user + feedback |
| 10 | Scheduler lives in the harness (`server/scribe-monitor.ts`, 60s timer, receipt-armed) and **calls the worker directly — no Scribe turn**. Worker holds **no BFF secrets**. The monitor cannot write Supabase rows (no credential, no `.env.ingest`): every armed event, including validation failures via `reject_reason`, is forwarded to `/join` and the worker writes the row | feedback, incorporated |
| 11 | **One shared STT server** for all concurrent capture bots (not one STT per bot) | feedback, incorporated |
| 12 | Arm receipt keyed on `instance_id|event_start` (restart never double-arms; reschedule re-arms). **Passcode never goes into a receipt, a log line, or a stored URL**. Receipt order is check → POST → write (§6.4): a crash between POST and write just re-posts onto the idempotent worker | feedback, incorporated |
| 13 | Failure/ready notices via relay@ mailbox through the PR 3 send helper (`sendMailboxCompletionEmail`), to organizer-then-creator if a known member (else log + skip); `scribe.notify` receipt; two fixed templates, no model call. Terminal states: `completed`, `partial`, `failed`, `skipped` — `partial` gets a notice, `skipped` writes the receipt with no email | feedback, incorporated |
| 14 | `/join` idempotent by `instance_id` (re-post returns the existing capture); shared-link unique violation → `skipped` row, not an error | feedback, incorporated |
| 15 | `transcripts.meetings` has **no URL column** (stale + Zoom `?pwd=` risk) and **`invitees`** (plain guest-list emails, no auth link) instead of `attendees`; `scheduled_start/end` kept for date listing | feedback, incorporated |
| 16 | One worker Chrome shared by Playwright (join + audio hook) and BladeBro attach (observe/fallback); Tool Layer lane bans bind research only | verified 2026-10-10, incorporated |
| 17 | Failure/admin notices go to `RELAY_SIGNIN_EMAILS` (existing allow-list, `server/account-signin.ts:17-23`) — no Supabase `auth.users` change, no weekly probe | user, incorporated |

`RELAY_MAILBOX_ADDRESS` / `RELAY_MAILBOX_USER_ID` come from Plan 1 — Scribe
does not define them.

## 4. Non-goals (MVP)

Transcript UI/viewer, manager surface, audio retention + playback, short
clips, in-meeting chat, recordings/share links, user-facing "send to Scribe",
entity linking to `app.people`/`app.companies`, summaries/action items,
organizer or visibility rules, Scribe role/turns, agent-driven recovery,
invite-sender tracking (later: monitor records invite-email sender per event
for a better "invited by" — needs no scope change, `gmail.readonly` already
covers it).

Expansion (not MVP): user-authenticated research connectors — a user logs in
to a site (e.g. X/Twitter, LinkedIn) once into an isolated profile, and an
agent drives that site's DOM to extract posts/content. Same profile-isolation
model as the Scribe login (separate home, manual login, failure-driven
re-auth); matches the "saved logins" connector direction in
`plans/scout-research.md`. Needs its own threat review (a logged-in social
profile is a high-value session) before scoping.

## 5. Architecture

See §1 diagram. Three runtimes, each with minimal secrets:
- **Harness** (`app`): `server/scribe-monitor.ts` polls relay@'s calendar,
  arms due meetings idempotently, POSTs descriptors to the worker, reconciles
  notices via `/status`. Holds BFF capability + actor secret (as today) plus
  `.env.scribe` (worker capability). Boot reads both capabilities into module
  variables and deletes them from `process.env` (PR 0 pattern) — this stops
  child processes from *inheriting* them, but it is not a boundary: a
  shell-capable agent in the same container (same user) could still read
  `/proc/<harness pid>/environ`. Accept that for this internal tool. Blast
  radius is bounded anyway: the worker capability can only start/stop captures
  of meetings that already pass host validation, and it can't write
  transcripts.
- **Tool Layer** (`tools`): ingest route + read/search tools only. Holds
  ingest secret (via `.env.ingest`) and BFF capability (as today). **No
  worker capability, no scribe tools.**
- **Scribe worker** (`scribe` service): join + capture + spool + ingest
  client; exposes one small endpoint. Holds **only** its endpoint capability
  (via `.env.scribe`) + ingest secret (via `.env.ingest`). No BFF secrets,
  no root env. The worker owns one Chrome per capture, launched with the
  signed-in Scribe profile (Playwright persistent context,
  `JOIN_BROWSER_ARGS` **minus `--incognito`** — incognito would discard the
  login — plus a fixed `--remote-debugging-port` so BladeBro can attach for
  observation/fallback; verified 2026-10-10 that Playwright
  `connect_over_cdp` and BladeBro `--host/--port` drive the same browser).
  Vexa's `joinMeeting(page, { authenticated: true })` skips name entry and
  fails closed with `AuthSessionError` on a signed-out profile.
- **STT server** (shared): one NeMo/ONNX service, `stt.v1` contract, reached
  by all worker slots over the compose network.

## 6. Component specs

### 6.1 Database — `supabase/migrations/0004_transcripts.sql`
(`0003_tool_call_attribution.sql` already exists. **No agent-enum change in
this file** — there is no Scribe role, so `history.conversations.agent` stays
`('scout','mercury','curator')` and `schema.test.ts:47-49` stays green.)

```sql
create schema if not exists transcripts;

create table transcripts.meetings (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('google_meet','zoom','teams')),
  instance_id text not null unique,            -- singleEvents=true id: unique per occurrence
  calendar_event_id text,                      -- recurringEventId when present (series grouping)
  native_id text,                              -- for the live-meeting index below
  title text,
  scheduled_start timestamptz,                 -- kept: failed/skipped rows have no actual_start
  scheduled_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  status text not null default 'joining'
    check (status in ('joining','awaiting_admission','active',
                      'completed','partial','failed','skipped')),
  error text,                                  -- failing step + /data/scribe/failures/<file> path
  organizer_email text,
  invited_by text,                             -- creator as best available (Google records no adder)
  invitees jsonb not null default '[]',        -- plain guest-list emails; never claims attendance
  audio_path text,                             -- null in MVP (Phase 2)
  segment_count integer not null default 0,
  duration_seconds numeric,
  ingested_at timestamptz,                         -- null until the final ingest lands
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No meeting_url column: URLs go stale, and Zoom links often carry the
-- passcode (?pwd=). The monitor sends the URL to the worker to join; nothing
-- persists it. No classification column: every transcript row is internal by
-- definition. (A column that segments don't carry would silently bypass the
-- Tool Layer read filter, which requires the column.)

-- One native meeting live at most once: blocks double-arm races. Null
-- native_id rows never match (NULL ≠ NULL), so a URL-parse failure must
-- become a failed row before any join attempt, never a live row.
create unique index meetings_live_once
  on transcripts.meetings (platform, native_id)
  where status in ('joining','awaiting_admission','active');

create table transcripts.meeting_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references transcripts.meetings(id) on delete cascade,
  segment_key text not null,                   -- stable across republish (turn/channel ids)
  channel integer,
  speaker text,                                -- nullable; render empty as "Unknown"
  speaker_key text,
  source text,                                 -- platform lane that produced it
  start_seconds numeric not null,              -- normalized: epoch floats → seconds from meeting start
  end_seconds numeric not null,
  text text not null,
  language text,
  confidence numeric,                          -- often absent; nullable
  is_final boolean not null default true,      -- MVP persists confirmed segments only
  search_vector tsvector generated always as
    (to_tsvector('english', coalesce(text, ''))) stored,
  created_at timestamptz not null default now(),
  unique (meeting_id, segment_key)
);
create index on transcripts.meeting_segments (meeting_id, start_seconds);
create index meeting_segments_search on transcripts.meeting_segments using gin (search_vector);

alter table transcripts.meetings enable row level security;
alter table transcripts.meeting_segments enable row level security;
-- No classification anymore, so policies are plain using (true): every
-- authenticated member may read every transcript. service_role bypasses RLS;
-- the Tool Layer is the real gate.
create policy "members read meetings"
  on transcripts.meetings for select to authenticated using (true);
create policy "members read segments"
  on transcripts.meeting_segments for select to authenticated using (true);

-- Grants mirror 0002_stores.sql:55-68 (usage to authenticated+anon, select to
-- authenticated only, all to service_role).
grant usage on schema transcripts to authenticated, anon;
grant usage on schema transcripts to service_role;
grant select on all tables in schema transcripts to authenticated;
grant all privileges on all tables in schema transcripts to service_role;

create or replace function transcripts.search_meetings(q text, lim integer default 20)
returns table (meeting_id uuid, segment_id uuid, speaker text,
               snippet text, start_seconds numeric, rank real)
language sql stable as $$
  -- Rank + limit in the subquery, headline only the survivors: ts_headline
  -- never runs on rows the limit discards. The computed column is aliased
  -- `score` (not `rank`): `rank` is an OUT parameter in scope here and would
  -- otherwise bind to NULL.
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

-- Surface the new schema to PostgREST: exact 0002 value + transcripts.
alter role authenticator set pgrst.db_schemas = 'public,app,logs,history,transcripts';
revoke execute on function transcripts.search_meetings from public, anon;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```

`services/tool-layer/src/schema.test.ts` must be updated deliberately:
- line 10: include the new migration in the concatenation (it currently reads
  only `0001`+`0002` — note it doesn't even read `0003` today).
- lines 19-25: add `transcripts.meetings`, `transcripts.meeting_segments` to
  the expected `created` list.
- line 40: delete
  `assert.doesNotMatch(migrations, /create schema if not exists transcripts/)`.
- Keep the `transcripts.email_threads` negative assertion — that table stays
  absent.
- Do **not** touch the agent-enum assertion (`schema.test.ts:47-49`).

### 6.2 Tool Layer
- **Read-only shape (the `history.conversations` precedent).**
  `services/tool-layer/src/domain/shapes.ts:69-80` already registers a table
  with `writable: []` — read-only for agents, written by the trusted server
  path. Register `transcripts.meetings` the same way: `writable: []`,
  `serverSet` all columns, `filterable: [id, platform, status,
  scheduled_start, organizer_email, calendar_event_id]`, `valueEnums` for
  `status`/`platform`, `require: []`. No attendee filter: the shape system
  has no array-contains operator (verified: `shapes.ts:83-84`,
  `database.ts:76-77` support only eq/gte/lte/in/like), so agents filter by
  `organizer_email` and read `invitees` off the returned rows. Date ranges
  use the verified `gte`/`lte` operators on `scheduled_start`. `read()` needs
  no `classification` column — schema comes from the table string
  (`database.ts:163-164`), and transcripts are simply not in
  `INTERNAL_ONLY_TABLES`. Do **not** register
  `transcripts.meeting_segments` — segments stay behind the bespoke tools
  (`relay_read` can't order/page transcript text).
- **Permissions** (`services/tool-layer/src/domain/permissions.ts`): add
  `relay/transcripts.meetings` to the `read` lists of scout, mercury,
  curator (`PERMISSIONS`, line 6). **No write entries** — `relay_write` is
  then denied twice: `authorize()` finds no write grant, and `prepareWrite`
  throws on the empty writable set (`shapes.ts:251`). Add
  `authorizeIngest(table, op)` allowlisting only the two transcript tables
  for INSERT/UPDATE/UPSERT.
- **Ingest, not shapes for writes**: add `RelayDatabase.ingestMeeting` /
  `ingestSegments` (`services/tool-layer/src/infra/database.ts`, beside
  `read` line 157 / `write` line 196). Contract:
  `{ meeting: {...}, segments: [{segment_key, speaker, start_seconds,
  end_seconds, text, ...}] }` → upsert by `(meeting.instance_id)` /
  `(meeting_id, segment_key)`; return `{ meeting_id, upserted }`.
  (No pending-id retraction: only confirmed segments are ever persisted.)
  A post **may contain a meeting with zero segments** — status-only
  transitions (`joining`, `awaiting_admission`, `failed`) all happen before
  any segments exist, so the meeting upsert must not require segments.
  A `meetings_live_once` violation must surface **distinguishably**:
  `supabaseError` already embeds the Postgres code (`database.ts:68-69`), so
  the route matches `23505` and returns **409 `live_meeting_conflict`**
  (not a generic 500) for the worker to turn into a `skipped` row.
  PostgREST schema handling is not hardcoded — `read()`/`write()` derive it
  from the table string (`database.ts:164,203`); the RPC goes through
  `client.schema('transcripts').rpc('search_meetings', ...)` the same way.
- **Route** (`services/tool-layer/src/http/server.ts`, before the `/mcp/*`
  match at line 73): `POST /internal/transcripts`, capability-bound
  (`Bearer $RELAY_INGEST_CAPABILITY` from `.env.ingest`, timing-safe like BFF
  `capabilityMatches`), max body 1 MB, **no loopback check, no actor
  assertion** (there is no agent here; loopback is not identity under
  `RELAY_LOOPBACK_TRUST=service`).
- **Read/search tools** (`services/tool-layer/src/mcp/`, follow the
  `registerBrowserTools` pattern at `mcp/browser-server.ts:31`):
  `list_meetings` **is `relay_read`** on `transcripts.meetings` (filters on
  `scheduled_start` range, optional attendee/status, limit) — no bespoke tool
  needed given the read-only shape above;
  `get_meeting_transcript({meeting_id, offset, limit})` →
  `{ meeting, segments, total_length, complete }` (`complete=false` while
  status is live); `search_meetings({query, limit})` → ranked snippets with
  speaker + `mm:ss`. Register the two bespoke tools on scout, mercury,
  curator. `instrumentToolCalls` (`mcp/agent-server.ts:42`) logs them to
  `logs.tool_calls` automatically. (If read-only registration ever stops
  working cleanly, fall back to a small bespoke `list_meetings` — do not
  widen the shape.)
- **Tests**: `relay_write` to either transcript table is **denied** (assert
  both the authorize path and the empty-writable error); `relay_read` lists
  meetings with date-range filters. Update test pins: `mcp.test.ts:46`
  (scout list), `mcp.test.ts:131-139` (scout + curator deepEqual),
  `research.test.ts:110` (scout deepEqual) — add the two new tool names.
  Mercury assertions are `includes`-based — unaffected. Add a fixture test
  for the `search_meetings` rank/score binding.

### 6.3 BFF — one `safeEvent` fix
`services/bff/calendar-internal.ts`, function `safeEvent` (line 192):
additionally return `hangoutLink`, `conferenceData`, `recurringEventId`,
`originalStartTime`. Without these there is no meeting URL and no series
grouping. Auth is unchanged: capability + `x-relay-actor-user` HMAC, no
loopback (`calendar-internal.ts:238-264`). `resolveCalendar` (line 215)
requires exactly one `google-calendar` connection for the actor UUID
(0 → 404, >1 → 409) — that constraint is what the relay@ identity satisfies
(§7). No scope change in this plan; runbook records scopes as granted (§7).

### 6.4 `server/scribe-monitor.ts` (new, harness side)
No file named "mailbox monitor" exists — follow the injected-deps + timer
pattern of `server/calendar-calls.ts` (`setInterval`, `ticking` reentrancy
guard, `start/stop`). PR 0 is on this branch (rebase done); confirm its
capability-retention interface plus the two signatures below at build:
- `mailboxBffBase(): string` and `mailboxBffCall<T>(capability, path,
  payload): Promise<T>` (`server/mailbox-bff.ts:8,12`) — posts to BFF
  internal routes signing a fresh actor assertion for Relay's own account
  from `RELAY_MAILBOX_ADDRESS`/`RELAY_MAILBOX_USER_ID`. The BFF capability
  arrives as a function argument from the in-memory holder, never env.
- `sendMailboxCompletionEmail({capability, email, title, detail})`
  (`server/mailbox-notify.ts:21`) — sends via `/api/internal/gmail/send`
  with `mailbox: "relay"`, secrets-redacted excerpt capped at 4k chars,
  kill-switched by `RELAY_MAILBOX_NOTIFY`. This is the PR 3 send helper §6.9
  uses. (`mailboxReplyNeedsNoEmail`'s NO_ACTION convention does not apply —
  scribe notices always send.)
- Deps (injected): BFF calendar client (relay@ actor assertion via
  `RELAY_MAILBOX_USER_ID`), worker client (endpoint + worker capability),
  notifier (PR 3 send helper), clock, logger.
- Every 60s: list **`[now-24h, now+24h]`** on relay@'s calendar (retained
  capability + fresh actor assertion). The back half arms upcoming meetings;
  the front half reconciles notices (§6.9) — one listing serves both.
- Arming: for events inside the join window not already tracked, check the
  `scribe.arm` receipt for `instance_id|event_start`; if absent, POST the
  descriptor to `/join`, **then** write the receipt. `withCommandReceipt`
  (`server/message-db.ts:296`) runs a synchronous SQLite transaction, so an
  HTTP POST cannot live inside `apply` — hence check → POST → write, the
  reserve-then-confirm order (a crash between POST and write just re-posts
  onto the idempotent worker, §6.5). A present receipt short-circuits, so
  **a restart never double-arms**, and a reschedule re-arms at the new time.
- The monitor **cannot write Supabase rows** (no credential, no
  `.env.ingest`), so it never creates the `failed` row itself: `apply` builds
  the join descriptor
  `{instance_id, platform, meeting_url, passcode, title, scheduled_start,
  scheduled_end, organizer_email, invited_by, invitees, calendar_event_id}`
  (all from `safeEvent`; the monitor already holds them), **validates the URL
  host** against `meet.google.com` / `*.zoom.us` /
  `teams.microsoft.com|teams.live.com`, and POSTs it — **including when its
  own validation fails, with a `reject_reason` field** — and the worker
  writes the `failed` row. Host-validation failure follows the same path.
  **The passcode is the only secret field: never into a receipt, a log line,
  or a stored URL** — descriptor transit and join memory only.
- Join policy lives here: start−60s, +5min late max, skip cancelled, Meet
  lobby timeout 10+ min, never "end for all", caps
  (`RELAY_SCRIBE_MAX_CONCURRENT`, max duration, `RELAY_SCRIBE_ENABLED` gate).
- Over-capacity: a meeting that would exceed `RELAY_SCRIBE_MAX_CONCURRENT`
  becomes a `failed` row with `error` `"at capacity"` (written via the same
  `/join` + `reject_reason` path) and triggers the failure notice — it must
  never vanish silently.

### 6.5 Scribe worker (compose `scribe` service)Own process: joiner + capture lanes + spool + ingest client + one small HTTP
endpoint (`POST /join|/status|/stop`) on the compose network, authenticated
by **`Bearer $RELAY_SCRIBE_WORKER_CAPABILITY`**. Environment:
**`env_file: [.env.ingest]` only** (ingest secret), plus explicit
`environment:` entries for non-secrets (STT URL, spool/failures roots,
provider domains, caps, worker host/port). **Never root `.env`/`.env.secrets`
(the OAuth client secret and token key live there, and the worker renders
untrusted pages).** No BFF secrets (it never calls the BFF). No published
ports. `data:/data`.
- **Joiner**: Vexa selectors (Meet/Zoom/Teams) — single deterministic path.
  Re-validate the descriptor URL host on receipt; fail closed otherwise.
  Meet joins run `authenticated: true` against the Scribe profile; a signed-out
  profile raises `AuthSessionError`, which becomes a `failed` row plus an
  admin re-auth notice (no silent anonymous fallback).
  The worker image must provide Vexa's hardcoded `/app/storage/screenshots`
  path (mkdir or bind into the failures dir).
  **`/join` is idempotent by `instance_id`**: a re-posted descriptor (e.g.
  monitor posted, then crashed before committing the arm receipt) returns the
  existing capture instead of starting a second one. A descriptor carrying
  `reject_reason` (monitor-side URL/host validation failed, over capacity)
  writes a **`failed` row without any join attempt**. A `meetings_live_once`
  violation from two calendar events pointing at the same Meet link becomes a
  **`skipped` row, not an ingest error** (the ingest route's 409
  `live_meeting_conflict` is the signal, §6.2).
- **No agent recovery.** On failure write a `failed` row: failing step +
  screenshot path in `error`. Screenshots live at
  `/data/scribe/failures/<instance-id>-<ts>.png` with a **14-day retention**
  cleanup timer (participant names). **The failure rate is the selector-drift
  metric; the fix is pulling upstream Vexa updates** — no model, no page
  tools, no extra endpoints.
- **Status file**: the worker persists a small status file per meeting on its
  volume (same 14-day retention as screenshots) so `/status` can answer for
  recently ended meetings across worker restarts.
- **Spool**: `/data/scribe/spool/<instance-id>/segments.jsonl`, fsync per
  confirmed batch; trickle upserts ~500 rows; delete dir only after final
  ingest ack. Crash recovery: on start, any local spool without a
  `completed` meeting row is re-pushed; any DB row stuck in a live status
  from a dead run becomes `partial`/`failed` with reason.
- **STT client**: `stt.v1` calls go to the shared STT server (§6.6), not a
  per-bot engine. Vendored code as listed in §6.7.

### 6.6 Shared STT server (new)
One service (NeMo for Canary, or runtime matching the §2.1 winner) exposing
the `stt.v1` multipart-WAV contract to all worker slots over the compose
network. Sized once (weights + headroom per concurrent stream) instead of
once per bot. Model weights + license notice ship with its image (Canary:
CC-BY-4.0 attribution).

### 6.7 Vendored capture code + roster report
Vendor under `third_party/vexa-capture/` with `LICENSE`, `README.md`,
`UPSTREAM_COMMIT = 18e7ac1d6a0201d1489ce30b12b6f7138067a598`
(Vexa v0.12.28, `github.com/Vexa-ai/vexa`; repo convention per
`third_party/`). Copy list:
- `core/meetings/modules/mixed-capture-core/src/{webrtc-audio-hook,teams-main-audio,csrc-poll}.ts`
- `core/meetings/modules/mixed-pipeline/src/{pyannote-segmenter,chunked-transcriber,cluster-name-binder,source-name-correlator,teams-csrc-channelizer,teams-contested-word-marker,hallucination-gate}.ts`
- `core/meetings/modules/gmeet-pipeline/src/{gmeet-pipeline,speaker-streams,hallucination-filter}.ts`
- `core/meetings/modules/whisper/src/{transcription-client,confidence}.ts`
- `core/meetings/modules/join/src/{googlemeet,zoom,msteams,shared}/**`
  plus root `_host.ts`, `browser-args.ts`, `index.ts`, `__tests__/` — and the
  `jitsi` lane, included although Scribe never instantiates it, because
  `index.ts` imports it and dropping it breaks the package
- Adapt (don't wholesale-copy) the orchestration seam:
  `core/meetings/services/bot/src/{capture-bridge,pipeline,join-driver}.ts`
- Bring the golden/contract tests:
  `confirm-loop.golden`, `pending-stability`, `webrtc-dedup`,
  `gap-reclaim`, `never-lose-tail`.
- **External deps** (package.json, do not vendor):
  `playwright@1.56.0` (Apache-2.0), `playwright-extra@4.3.6` (MIT),
  `puppeteer-extra-plugin-stealth@2.11.2` (MIT),
  `@huggingface/transformers@4.2.0` (Apache-2.0),
  `onnxruntime-node@1.17.0` (MIT),
  `onnx-community/pyannote-segmentation-3.0` weights (MIT conversion; notice
  governed by pyannote.audio), winning STT checkpoint.
- **Roster lookup (report back, no code)**: search `third_party/vexa-capture`
  and upstream Vexa's bot service for participant / roster / attendee
  extraction. Per platform report: does it read the participant list at all;
  display names or emails; polled during the meeting or read once; in the
  copied files or the orchestration layer; effort to port. Caution: Vexa's
  own meeting record showed a roster field that was always "not recorded,"
  so it may not exist in Vexa itself. Whatever a platform shows is display
  names, not emails — it can't be matched to your users reliably anyway. If
  nothing exists, the distinct speaker names in the transcript are the
  fallback.
  - Outcome (2026-10-10, verified against `18e7ac1`): **nothing to port.**
    Meet People-panel button selectors exist
    (`join/src/googlemeet/selectors.ts:454-467`) but no code opens the panel
    or reads names. Teams' "roster/lobby oracle" (`msteams/README.md`) is
    admission-state detection only. Zoom has nothing. "Roster" inside the
    binder (`track-namer.ts`) means the discovered speaker-name universe
    built from DOM hints — not a meeting participant list. Upstream
    `services/bot` (orchestrator, signals, adapters) has no participant-list
    extraction. Fallback stands: distinct speaker names from segments.

### 6.8 Compose + env
- `scribe` service in `compose.yaml`: same image,
  `deploy/local/start-scribe.sh`, `env_file: [.env.ingest]` + explicit
  `environment:` (per §6.5), no published ports, `data:/data`.
- `tools` service gains `.env.ingest` in its `env_file` list (augment, don't
  replace — it still needs the shared secrets).
- `app` service gains `.env.scribe` in its `env_file` list (monitor → worker
  calls). It must **not** gain `.env.ingest`.
- `.env.ingest` (new, root, gitignored like `.env.secrets`) holds exactly:
  `RELAY_INGEST_CAPABILITY` (≥32 bytes). Loaded **only** by `tools` and
  `scribe`.
- `.env.scribe` (new, root, gitignored) holds exactly:
  `RELAY_SCRIBE_WORKER_CAPABILITY` (≥32 bytes). Loaded **only** by `app`
  and `scribe`. It can start/stop captures but can't write transcripts.
- **Capability hygiene (harness boot)**: read both capabilities into module
  variables at boot and **delete them from `process.env`** (same fix PR 0
  applied to the BFF capability). This stops child processes from
  *inheriting* them — extend the boot test to assert neither appears in any
  engine's spawn environment. It is **not** a boundary and must not be called
  one: a shell-capable agent in the same container (same user) could still
  read `/proc/<harness pid>/environ`. A true boundary would need engines
  running as a different user. Accept the residual risk for this internal
  tool — the worker capability's blast radius is start/stop of captures that
  already pass host validation, and it can't write transcripts.
- Document in `.env.example` + `deploy/local/README.md`. Single pushes only
  (CI concurrency groups self-cancel rapid pushes).

### 6.9 Failure notices (harness side, step 7)
No webhook, no database column. The monitor's 48-hour listing (§6.4) already
covers it: for each event with a `scribe.arm` receipt but **no**
`scribe.notify` receipt, ask the worker for that `instance_id`'s status
(served from its status file, §6.5 — so a meeting that finished while the
harness was down is still answerable). Terminal states are `completed`,
`partial`, `failed`, `skipped`: `completed`/`partial` get the ready notice,
`failed` gets the failure notice (including `"at capacity"`), and `skipped`
**writes the `scribe.notify` receipt with no email**. Non-terminal states are
re-checked next tick — but with an exit: if the worker has **no record** of
an armed event after `scheduled_end` + 30min grace, write the receipt and log
it, so the loop stops instead of polling for the rest of the 48h window.
On a terminal state with email due, send via
`sendMailboxCompletionEmail({capability, email, title, detail})`
(`server/mailbox-notify.ts:21`) — **from the relay@ mailbox**, addressed to
the **organizer, falling back to the creator** — and only if a known member
(the same check PR 3 already does). Otherwise log and skip (externally
organized meetings have no recipient; that must not be a surprise). Record
`withCommandReceipt("scribe.notify", `<instance_id>`, …)` so each notice is
**sent once**. The harness never needs a Supabase credential — state comes
from the worker `/status`, identity from the calendar event.
- Template 1 (failed): `Relay couldn't join "<title>" (<date>): <reason>.`
- Template 2 (completed): `Transcript ready: "<title>" (<date>).`
- Both are short fixed templates — **no model call.**
- System-level failures (`AuthSessionError` = profile signed out, repeated
  Meet refusals suggesting an IP/policy block) go to **admins** instead of
  the inviter: `RELAY_SIGNIN_EMAILS` (the existing allow-list,
  `server/account-signin.ts:17-23` — no Supabase change). Same one-shot
  receipt pattern (`scribe.notify:<kind>:<instance_id>`); the auth template
  tells a human to re-run the one-time login (§7).

### 6.10 Step 6 progress — slice 1 (Meet) built
`services/scribe-capture/` exists:
- `src/http-server.ts` — capability-authed `POST /join|/status|/stop`,
  `GET /healthz`; `/join` idempotent by `instance_id`.
- `src/session.ts` — `SessionController` (one session per instance_id) +
  authenticated persistent-context join via the vendored Vexa join (loaded
  lazily so third-party code stays out of our typecheck), capture loop, flush,
  lifecycle: meeting row `active` at join with `actual_start` = capture time
  zero; `completed`/`partial`/`failed`/`skipped` finalize; at-capacity and
  non-provider-host descriptors become `failed` without joining.
- `src/capture-init.ts` — the in-page PCM tap (slice 1: mixed stream,
  `speaker: null`).
- `src/spool.ts` (flush 50 rows / 17.5s), `src/ingest-client.ts`,
  `src/stt-client.ts` (HTTP WAV → text), `src/config.ts`.
- `stt/parakeet_server.py` — shared STT server (Parakeet int8, env-configured).
- Offline tests: spool policy, ingest client (bearer/409/503/502), HTTP
  capability + idempotency. `pnpm --filter @relay/scribe-capture test` 13/13,
  typecheck + lint clean.

Slices 2–4 (monitor, Zoom/Teams, notices/compose) still pending.

### 6.11 Step 6 progress — slices 2 & 3
- **Slice 2 (monitor, harness side)** — `server/scribe-monitor.ts`:
  `ScribeMonitor` polls relay@'s calendar `[now-24h, now+24h]`, arms each
  meeting entering its join window, and posts a descriptor to the worker.
  Receipt order check → POST → write (crash between the last two re-posts onto
  the idempotent worker). A worker-unreachable error leaves the receipt
  unwritten so the next tick retries. Pure helpers (`platformForUrl`,
  `meetingUrlFor`, `eventStartMs`, `armKey`, `buildDescriptor`) are exported.
  Supporting: `server/scribe-receipts.ts` (command-receipt store, same
  primitive as the mailbox monitor), `server/scribe-worker-client.ts`
  (capability-authed `/join`), `server/scribe-calendar.ts` (BFF internal
  calendar list via PR 0's `mailboxBffCall`). Tests 9/9.
- **Slice 3 (Zoom/Teams code path)** — `services/scribe-capture/src/urls.ts`
  (`meetCode`, `nativeIdFor`, `hostAllowed`) + `session.ts` generalized:
  `platform` from the descriptor, `authenticated` only for Meet, per-platform
  `leave`, per-platform `native_id`. Live Zoom/Teams runs still need links +
  admitters. Worker tests 16/16.
- Wiring the monitor into `server/index.ts` (gate + in-memory capabilities +
  start/stop) is slice 4, alongside compose + env files.

### 6.12 Monitor gaps closed + slice-4 code (2026-10-11)
- **Permanently unreachable worker:** once the join window closes (start +
  lateMax) with no arm receipt, the monitor writes a terminal receipt, records
  a `scribe.notify` receipt, and calls an injected `notify` with reason
  "capture service unreachable" — so the loop stops and a notice is sent from
  the harness. Worker-unreachable *inside* the window still retries.
- **Over-capacity:** a worker refusal (`status: failed`) is terminal — the arm
  receipt is written, so there is no retry loop; the failure notice comes from
  reconciliation.
- **Quiet skips:** cancelled, all-day, no-link, non-provider host, and
  relay@'s own meetings (`selfAddress`) are skipped with no receipt and no
  notice. Tests cover each.
- **Passcode hygiene:** `passcodeFor` extracts the passcode (entry point or
  `?pwd=`) into the descriptor only; a test asserts it never appears in logs or
  receipts.
- **Signed-out detection (worker):** `describeJoinFailure` maps
  `AuthSessionError` / "signed out" to a specific reason
  ("relay@ browser profile is signed out — re-authenticate the Scribe
  profile") written on the `failed` row.
- **Retention + disk (worker):** `maintenance.ts` sweeps `/app/storage/screenshots`,
  `<data>/failures`, `<data>/status` (14-day retention) and logs a low-disk
  error below a threshold; wired on an interval in the worker entrypoint.
- Tests: monitor 12/12, worker 19/19; server + worker typecheck and lint clean.

**Gate (before deploy):** Meet capture is the mixed tap (`speaker: null` →
"Unknown"). Per the plan it must move to the per-channel lane
(`third_party/vexa-capture` `gmeet-pipeline` + `speaker-streams`) so the
speaker column carries names, before anything is wired into production. This
also changes the per-bot resource numbers, so compose limits wait on it.

### 6.13 Gate probe — offline slice built (2026-10-11, Phase A)
The per-channel Meet lane's offline parts are built; the live probe is the gate
run. What exists now:
- **Vendored** (Apache-2.0, pinned `18e7ac1`): `gmeet-capture` (page-side
  per-participant PCM + AudioWorklet + glow speaker naming + the energy↔glow
  `GmeetChannelBinder`), `buffer` (`@vexa/transcribe-buffer`), and the sealed
  `contracts/transcript.v1` schema. `gmeet-pipeline` was re-laid out to keep its
  `src/` level so its conformance golden resolves the schema. All vendored
  goldens run UNMODIFIED via `pnpm --filter @relay/scribe-capture test:vendored`
  (16 files). See `third_party/vexa-capture/README.md` for the layout +
  adaptation record.
- **Page glue** `services/scribe-capture/src/capture-gmeet.entry.ts` (bundled by
  `scripts/build-capture.mjs` → `dist/gmeet-capture.bundle.js`, injected via
  `addInitScript`): composes the vendored bricks and exposes
  `window.__scribeGmeet` (`start/stop/drain/state/tiles/probeDom`). **Adaptation:**
  one shared `AudioContext` for all streams (upstream creates one per stream,
  which Chromium caps at ~6 → larger meetings would lose audio silently).
- **Probe mode** (`RELAY_SCRIBE_GMEET_PROBE=1`, Meet only): runs the per-channel
  lane ALONGSIDE the mixed tap for one session and writes a naming artifact
  (`<probeDir>/<instance_id>.json`: per-channel frames with meeting-relative
  timestamps, derived bind transitions, tile snapshots incl. the bot's own tile,
  `dom_start/dom_end` probes, and `path` = `dom`|`hook`). Default `probeDir` is
  `/data/scribe/probes`. **Privacy:** artifacts contain participant names +
  meeting content — VPS-local only, deleted after review, never committed; only a
  redacted summary belongs in `evals/fixtures/scribe/`.
- **Duplicate display names (limitation):** two participants who share a display
  name cannot be told apart from the DOM. `src/gmeet-labels.ts` disambiguates by
  tile identity — the first tile keeps the name, later same-named tiles become
  `"Dana (2)"`, `"Dana (3)"` — so the binder never merges or picks one. It can
  never emit a WRONG name; if a tile is unnamed its channel stays `Unknown`.
  Pinned by `src/gmeet-labels.test.ts`.
- **Decision rule:** if most turns carry the correct name in the 3-person probe,
  ship the per-channel lane (Phase B: feed `gmeet-pipeline`, stable
  `ch<n>:<start_ms>` segment keys, VAD gate, stream cap). Otherwise fall back to
  the vendored mixed lane + pyannote + hints binder.

#### 6.13.1 Live probe result (2026-10-11, VPS, 3-person Meet)
Admitted ~22 s, `active`, 3 remote speakers, 155.6 s, 17 mixed segments.
- **`path=dom`** — Meet exposes native `<audio>` elements with live `srcObject`;
  the hook was not needed. **No structural audio↔tile link**: every probed audio
  element had `participantId=null`/`tileName=null`, so glow↔energy correlation is
  the only naming path — and it worked.
- **Names resolved correctly per channel** — `Pranam Shetty`, `Hotel Pancharatna`,
  `Miguel O'Hara` (the 3 roster tiles). 135/864 frames were `Unknown` (uncertain)
  — never a wrong name. Transitions bound each channel to the matching tile.
- **Bug found + fixed (harness artifact):** the mixed tap's remote-audio hook ran
  alongside the lane, mirroring each remote track into a second `<audio>` → **6
  channels for 3 speakers** (3 native + 3 mirrored, same track ids). The duplicate
  pair made the binder's 1:1 rule thrash on the long speaker (116 null↔name
  transitions). Root cause: dedupe by `stream.id` (mirrors get a new stream id).
  Fixed in `capture-gmeet.entry.ts` to dedupe by **audio track id**.
- **Dedupe fix confirmed live** (second run, 3-person Meet, 189.7 s): 
  `stream_count=3`, three stable channels (ch0→Pranam, ch1→Miguel, ch2→Hotel),
  only 19 transitions total (brief `Unknown` gaps at turns/crosstalk), no
  cross-assignment. `dom_start` still showed 6 audio elements (3 native + 3 hook
  mirrors, same track ids) — the track-id dedupe collapsed them to 3.
- **Self tile not detected** (no `data-self-name`; the bot's tile had name `null`).
  Likely a Google-assigned display name / absent marker on a Workspace account
  without a set name. `setSelfName` never fired; the bot is muted so no self glow
  in these runs. Phase-B robustness item: identify self structurally (or from the
  bot's own `data-self-name`/participant id) so a speaking bot can't bind a remote
  channel.
- **Decision: PASS — proceed with the per-channel lane (Phase B).**
- Artifact: `<probeDir>/probe-irk-*.json` (kept on the VPS; redacted summary only
  into `evals/fixtures/scribe/`).

#### 6.13.2 Phase B — per-channel Meet lane built + live-verified (2026-10-11)
- **Meet capture is now the per-channel lane** (`session.ts`): inject the
  remote-audio hook + the entry bundle, feed frames to the vendored
  `createGmeetPipeline` (loaded lazily by relative specifier, like the join
  layer), map emitted `TranscriptSegment`s → store rows. The mixed tap remains
  for Zoom/Teams (unchanged); Meet no longer uses it.
- **Mapping** (`gmeet-segment.ts`, pure + tested): times become meeting-relative
  seconds from capture start; `segment_key = ch<channel>:<start_ms>` (stable, so a
  re-flush upserts the same row); the pipeline's `Speaker` placeholder → `null`;
  `channel`/`speaker_key`/`source`/`confidence` persisted (the ingest route
  spreads segment fields onto the table).
- **Silence gate + stream cap**: the entry drop-gates near-silent frames and caps
  concurrent streams (`RELAY_SCRIBE_MAX_STREAMS`, default 12); `selfName` via
  `RELAY_SCRIBE_SELF_NAME`.
- **Live end-to-end (VPS, real ingest → Supabase)**: 3-speaker Meet, 26 rows
  written with real names (`Hotel Pancharatna`, `Pranam Shetty`, `Miguel O'Hara`),
  `source=glow-bound`, `confidence=1`, channels 0–2, meeting-relative times
  `1.05`→`146.8`s, keys `ch<n>:<epoch_ms>`; meeting row `partial`,
  `segment_count=26`, `duration≈154`s.
- **Caveat (owed):** the opening ~4 s settled after two channels briefly shared a
  name before re-binding — confirm against a roster whether any single speaker's
  continuous talk was split across two channels (needs a roster-annotated run).
  Self-tile detection still open (see above).
- Verification: worker 27/27, vendored 16/16, monitor 12/12, evals 6/6, lint +
  server tsc clean.

#### 6.13.3 Compose + images built (2026-10-11, item 6)
- `deploy/local/Dockerfile.scribe`: Node + Playwright Chromium, filtered
  workspace install (scribe-capture + the vendored `@vexa/*` modules), bundle
  built in-image; runs the worker via tsx. `deploy/local/start-scribe.sh` execs
  so a fatal exit trips `restart: unless-stopped`.
- `deploy/local/Dockerfile.stt`: Python + sherpa-onnx + Parakeet TDT 0.6B v2 int8
  (model baked, ~480 MB build download); attribution in `STT-NOTICE.md`.
- `compose.yaml`: `scribe` (`:8791`, `scribe_data` volume mounted ONLY here, no
  published ports, mem_limit, healthcheck) and `stt` (`:8090`, mem_limit,
  healthcheck); `app` gains `.env.scribe` + `RELAY_SCRIBE_WORKER_URL`, `tools`
  gains `.env.ingest`.
- `.env.ingest` / `.env.scribe` split capabilities + gitignored; examples added;
  `.env.example` + `deploy/local/README.md` document the config, the one-time
  relay@ login, and the deploy order (Tool Layer → worker+STT with
  `RELAY_SCRIBE_ENABLED=0` → verify → enable).
- Verified: both images build; `docker compose config` clean; `scribe`
  smoke-tested (healthz OK, `/join` 401 without capability, bundle + Chromium
  present); `stt` smoke-tested (model loads, `/transcribe` returns text).

#### 6.13.4 Monitor wired into the harness (2026-10-11, item 2)
- `server/index.ts`: `RELAY_SCRIBE_WORKER_CAPABILITY` read into a module const and
  deleted from `process.env` (mirrors `relayBffCapability`); `RELAY_SCRIBE_WORKER_URL`
  default `http://127.0.0.1:8791`. The `ScribeMonitor` is constructed only when
  `RELAY_SCRIBE_ENABLED=1` **and** the BFF capability, worker capability, and
  `RELAY_MAILBOX_ADDRESS` are present (`selfAddress`), with
  `createCalendarEventLister` + `createWorkerJoinClient` + `commandReceipts()`.
  Started/stopped with the mailbox hooks (boot start, graceful stop, and the
  workspace-maintenance pause/resume set). Notices (`notify`) are still slice 4.
- **Gate rationale:** `RELAY_SCRIBE_ENABLED` is an action-safety/deploy switch,
  not a feature flag — enabling it makes the bot join real meetings and spend
  STT CPU, so it must not turn on merely by deploying the branch. Default off.
- Verified: server tsc + lint clean; monitor 12/12; BFF 77/77; evals 6/6.

#### 6.13.5 Capability-scrub boot test (2026-10-11, item 3)
- `server/boot-capabilities.ts`: `holdHarnessCapabilities()` reads
  `RELAY_BFF_CAPABILITY` + `RELAY_SCRIBE_WORKER_CAPABILITY` into memory and
  deletes them (plus `RELAY_INGEST_CAPABILITY` defensively) — called at module
  top, before the monitors or any engine. Scope stated honestly: stops
  inheritance, not a `/proc/<pid>/environ` boundary.
- `server/scribe-capability-scrub.test.ts`: spawns a real child **through the
  actual `spawnCli` seam** and has it dump `process.env` — asserting no
  capability is visible whether the env is passed directly, spread
  (`{ ...process.env }`), or inherited. Must pass before enabling.
- `server/deploy-compose.test.ts`: parses `compose.yaml` and pins capability
  separation — `app` never loads `.env.ingest`, `tools` never loads
  `.env.scribe`, `scribe` loads both, and `app` reaches the worker at
  `http://scribe:8791` (not loopback).
- Monitor startup now logs either `monitor enabled -> <url>`, a warn naming the
  exact missing variable(s), or `monitor disabled (RELAY_SCRIBE_ENABLED != 1)`.

## 7. Identity + calendar runbook (one-time, operator)
1. Create the relay@ Google account (new account, owned by the team).
2. Sign in once as relay@ in the Relay web UI; complete Google OAuth.
   **Record the granted scopes; the code only ever lists events** (no BFF
   scope change in this plan).
3. The relay@ Relay UUID is `RELAY_MAILBOX_USER_ID` (Plan 1 owns the name).
   Exactly one `google-calendar` connection must exist under it in
   `google-connections.json` (`RELAY_DATA_DIR`, i.e. `/data` on the VM;
   `services/bff/google-connections.ts:101,279`).
4. The monitor mints relay@'s actor assertion per poll with
   `signActorAssertion`
   (`services/tool-layer/src/infra/actor-assertion.ts:26`) using
   `RELAY_TOOL_ACTOR_SECRET` (5-min skew).
5. Verify: `POST /api/internal/calendar/events/list` returns relay@ events;
   a second connection for that UUID must never be added (route 409s).
6. Mercury's calendar tools are unaffected: they resolve the signed-in
   human's own `userId`, never relay@'s.
7. VPS-gate variant: sign relay@ **into the capture profile** as well, so the
   gate can compare anonymous vs signed-in Meet joins (§8).
8. One-time Scribe-profile login **on the machine that runs the worker
   (the VPS — not a laptop)**. Google binds sessions to egress IP: a profile
   logged in elsewhere and copied over (or used remotely) trips
   suspicious-activity challenges and voids the session. Headful Chromium on
   the VPS (Xvfb + x11vnc on localhost, SSH tunnel to a local VNC viewer),
   sign in as relay@ (Workspace account, complete 2FA), open Meet once to
   confirm, close the browser. Cookies persist in the profile; the worker
   runs headless after. Proven 2026-10-10: manual VNC login → cookies
   present → headless persistent-context reuse reaches the authenticated
   lobby. The password is typed by a human and never touches the repo, logs,
   or agent context. Liveness is failure-driven (no scheduled probe): the
   first `AuthSessionError` triggers the admin re-auth notice (§6.9).
8. Later improvement (skipped for MVP): monitor records each invite email's
   sender against its event for a better "invited by" — needs no scope
   change, `gmail.readonly` already covers invite headers/bodies.

## 8. Test plan
- Unit/golden: copied Vexa contract tests must pass unmodified in the new
  tree (binder extraction gate).
- Tool Layer: `mcp.test.ts`, `research.test.ts`, `schema.test.ts`,
  BFF `calendar-internal.node-test.ts` (new `safeEvent` fields); new monitor
  tests (receipt short-circuit incl. reschedule re-arm, check→POST→write
  order, caps incl. at-capacity `failed`, passcode-never-logged, notice-once
  receipt, terminal set incl. `partial`-noticed / `skipped`-silent, no-record
  grace exit, capability-scrubbed spawn env);
  worker endpoint tests (capability auth, host validation, idempotent
  re-post, shared-link → `skipped`, URL-parse failure → pre-join `failed`).
- Fixtures: real redacted transcripts → `evals/fixtures/scribe/` (follows the
  existing `evals/` offline/golden/live tiers + CI wiring).
- **STT head-to-head**: Canary 180M vs Parakeet TDT 0.6B on the fixtures
  (crosstalk + finance terms) measuring accuracy, image size, cold start,
  idle RAM; check for a lighter Parakeet ONNX export. Requires a ~10-minute
  recording with crosstalk and real company names plus a hand-corrected
  reference transcript — without it the models can only be compared against
  each other, not measured.
- VPS gates (need the cloud box + §12): join from VPS on all three platforms;
  **Meet both anonymously and with relay@ signed into the capture profile**;
  check the Meet safety settings in the Workspace admin console; Meet
  admission timing with a real host; peak RAM/CPU per live bot against the
  shared budget (shared STT + N worker slots + browsers).
- **VPS pass/fail** (give the dev these criteria): Join — unattended success
  on Zoom and Teams and on Meet with a host admitting, ≥3 attempts per
  platform at different times. Capture — audio flowing ≤30s after entering,
  named speakers on most turns (expect more "Unknown" on Teams). Meet
  admission — record join-to-admit time. Cost — peak RAM/CPU per live bot.
  **Fail condition: Meet refused both anonymous and signed-in → stop and
  report** (shape-changing result).
- Join is verified per-attempt by code (in-meeting + audio flowing), and
  every failure writes a `failed` row with step + screenshot path. The
  **failure rate over time is the selector-drift metric**.

## 9. Build order (each step green before the next)
1. **VPS join test** (throwaway script, no repo code) — go/no-go for the
   whole plan. Anonymous + signed-in Meet, Zoom, Teams, Workspace admin
   check, pass/fail per §8. **If Meet admission fails, the plan changes
   shape — find out first.** Requires §12 from the operator.
2. `0004_transcripts.sql` (per §6.1, **no enum change**) + `schema.test.ts`
   update + read-only shape + scout/mercury/curator read grants + deny-tests.
3. BFF `safeEvent` fields + test; `authorizeIngest` + ingest methods +
   capability-bound route (no retract) + read/search tools + test pins;
   vendoring + attribution + copied tests green + **roster-lookup report**.
4. Rebase done (`0d09e8d` sits on the four mailbox commits). Confirm PR 0
   (capability retention, `server/mailbox-bff.ts:8,12`) and PR 3
   (`sendMailboxCompletionEmail`, known-member check,
   `server/mailbox-notify.ts:12,21`) interfaces against the in-tree code —
   §6.4 and §6.9 quote the signatures; verify at build.
5. `server/scribe-monitor.ts` (48h window, descriptor build, receipt arming,
   `/status` reconciliation) + worker endpoint skeleton + tests. No role work.
6. Worker pipeline (join → binder → STT client → spool → ingest); shared STT
   server with the §2.1 winner.
7. relay@ runbook (§7) + `.env.ingest` + `.env.scribe` + compose `scribe`
   service + `start-scribe.sh` + env docs + capability hygiene + failure
   notices (§6.9).
8. VPS spike (§8 gates). Phase 2 (audio, viewer) only after.

## 10. Open items
1. STT winner pending the §2.1 head-to-head (needs the §8 reference
   recording first).
2. relay@ setup: one-time web sign-in (recommended) vs operator OAuth script.
3. PR 0 / PR 3 interfaces are now in-tree (§6.4/§6.9 quote them) — verify at
   build, no longer a scheduling blocker.

## 11. Reference index
- Tool Layer server/routes: `services/tool-layer/src/http/server.ts:52-73`
  (healthz at 52 with search-provider probe, `/mcp/(scout|mercury|curator)` at 73),
  (healthz, `/mcp/(scout|mercury|curator)` — unchanged, no 4th route),
  agent tools `services/tool-layer/src/mcp/agent-server.ts:42-100`, DB
  `services/tool-layer/src/infra/database.ts:15,157,196`
- Shapes precedent: `services/tool-layer/src/domain/shapes.ts:69-80`
  (`history.conversations`: `writable: []`, server-written; write path throws
  at `shapes.ts:251` on empty values); read/write grants
  `services/tool-layer/src/domain/permissions.ts:6-47` (no write entries =
  authorize-level denial)
- Timer pattern: `server/calendar-calls.ts:180-335` (injected deps,
  `setInterval`, `ticking` guard); receipts `server/message-db.ts:296`
  (`withCommandReceipt(kind, key, apply, at)`), sole caller
  `server/commands.ts`
- Mailbox transport + notices (PR 0 / PR 3, on this branch):
  `server/mailbox-bff.ts:8,12` (`mailboxBffBase`, `mailboxBffCall` — capability
  passed as arg from in-memory holder, fresh relay@ assertion per call),
  `server/mailbox-notify.ts:12,21` (`mailboxReplyNeedsNoEmail`,
  `sendMailboxCompletionEmail`, `RELAY_MAILBOX_NOTIFY` kill switch)
- Roles: `packages/relay-shared/relay-agent.ts:1` — unchanged (no Scribe
  role); BFF calendar:
  `services/bff/calendar-internal.ts:9,127,192,215,240`, scopes
  `services/bff/google-api.ts:34-57`, store
  `services/bff/google-connections.ts:101,279`
- Migrations: `supabase/migrations/{0001_init,0002_stores,
  0003_tool_call_attribution}.sql` (agent check: `0002:17-18` — untouched;
  grants/pgrst: `0002:55-72`; `logs.tool_calls.agent` unconstrained,
  `0003:11`; `0001 actor_agent` unconstrained); tool logging
  `services/tool-layer/src/mcp/tool-log.ts`
- Scoped browsers: Tool Layer Bladebro pool
  (`services/tool-layer/src/infra/bladebro.ts:4-6`, per-user daemon) ≠
  worker capture browser (carries the WebRTC hook) — and with no agent
  recovery, nothing needs to bridge them
- Deploy: `compose.yaml` (app/tools/caddy → +scribe), `deploy/local/{Dockerfile,
  start-app.sh,start-tools.sh,README.md}`, `.env.example`
- Upstream: `github.com/Vexa-ai/vexa@18e7ac1` (Apache-2.0),
  `github.com/joinly-ai/joinly@v0.5.4` (MIT, parked — §2.3);
  Canary `nvidia/canary-180m-flash` (CC-BY-4.0, NeMo-only)

## 12. What the dev needs for the VPS test (operator supplies)
Step 1 cannot start without all five:
1. **A VPS, ideally throwaway**, from the same provider and region as
   production — the datacenter IP range is part of what's tested. Minimum
   **4 vCPU, 8 GB RAM, Docker, Ubuntu**.
2. **A dedicated SSH key for the dev** — not a personal key. Delete it after
   the test.
3. **Real meetings + a person to admit the bot**: a Meet hosted by a teammate
   (someone must click admit — that wait is also the timing measurement), a
   Zoom meeting, and a Teams meeting.
4. **relay@'s credentials only on the VPS**, as environment variables the
   throwaway script reads. Never paste them into chat. Required for the
   signed-in Meet variant.
5. **Workspace admin console access** for the Meet safety-settings check, or
   a screenshot of those settings.
