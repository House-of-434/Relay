# Cloud MVP — Deployment of Current Features

**Status: locked.** Execution order is part of the lock: deploy/local first,
then ownership, then the rest. Do not reorder.

Deploy the Relay architecture **as it is today** on Oracle Cloud
Infrastructure, with a small cohort of internal users, and let the deployment
itself be the architectural test. No storage rewrite first. No new services.

Cohort: a small number of internal users. Growth is expected, so per-user
correctness must hold from the first deploy — but nothing here is sized to a
headcount.

## Why this order

A TypeScript-AST audit of `Store` (81 public members) plus a receiver-aware
call-site scan found **zero unreferenced public methods**. Four methods
(`activeTask`, `activeGroupTask`, `renameTask`, `dismissOnboardingCard`) look
dead to a regex but each has internal callers inside `server/store.ts`. The
Store is genuinely integrated, so there is no dead-weight argument for
rewriting it.

Static analysis cannot tell us whether SQLite behaves under real load, how
large the database grows, or whether Bladebro works on an OCI datacenter IP.
Only a deployment answers those. So: **deploy first, measure, then decide.**

`thread_owners` is deliberately developed *after* the deployment path is
green: it can be built independently, but it proves nothing until there is an
environment in which the ownership chain runs.

## Explicitly out of scope

Do not, before Phase 5: rewrite `Store` as async · remove any Store method ·
make Postgres the live message store · build SQLite backup/recovery · treat
NDJSON as a durable source of truth · introduce Langfuse or centralized
observability · build the thread-list UI · add Parakeet transcription.

`server/message-db.ts` is synchronous (`DatabaseSync`, WAL) and is wired into
nine non-test modules. Three of its call sites cannot take an `await` without
restructuring their *callers* (`server/index.ts:23271-23306` top-level module
scope, `server/index.ts:23411` which calls `process.exit`, and the `Store`
constructor chain at `server/store.ts:900,904`). That work stays deferred
until measurement justifies it.

## Architecture

```
                         Internet
                            │
                     ┌──────────────┐
                     │    Caddy     │  TLS termination
                     └──────┬───────┘
                            │  http://omb:80 (internal)
                  ┌─────────┴──────────┐
                  │  Relay / BFF       │
                  │  :8799 / :8798     │
                  │  SQLite  /data     │
                  └────┬─────────┬────┘
             http MCP   │         │  Supabase (PostgREST + Auth)
        ┌────────────────┘         └──────────────┐
        ▼                                          ▼
┌──────────────────┐                    ┌──────────────────┐
│  Tool Layer      │                    │  Supabase        │
│  :8787           │                    │  app.* / auth    │
│  Bladebro+Chrome │                    │  (scoped writes) │
└──────────────────┘                    └──────────────────┘
```

One VM initially. Browser and (future) transcription stay behind **explicit
service boundaries** so either can move to a dedicated worker VM later by
changing a URL, with no Relay redesign. This boundary already exists: the
Tool Layer is a separate service on `:8787` hosting the Bladebro adapter
(`services/tool-layer/src/infra/bladebro.ts`), and `RELAY_TOOL_URL` already
points at it.

### Data placement, and why

| Data | Home | Reason |
|---|---|---|
| Transcripts | SQLite on the block volume | Working, fast, transactional. One host = fine. |
| Threads / bots / rooms | JSON + NDJSON under `/data` | Same. |
| Decision log (NDJSON) | Block volume, pruned | Config already exists: `decisions.retentionDays`, default **180 days** (`server/decision-log.ts:111`, bound at `server/index.ts:761`). |
| Org knowledge | Supabase `app.*` | Load-bearing and already verified end to end. |
| Auth | Supabase Auth | See below. |
| Attachments | Block volume under `/data` | Needs a download route — Phase 2. |

Risk of SQLite on a VM is not "SQLite can't run in the cloud." It is VM
failure, needing multiple servers, or needing DB access independent of the
host. None apply yet. **No backup/recovery project is built for the MVP** —
that is infrastructure creep against a store slated for migration. The
deployment docs carry one note instead:

> **MVP persistence is SQLite on the persistent `/data` volume. Migration to
> Supabase/Postgres is planned before treating this deployment as production
> durable storage.**

### Auth — verified, nothing to build

Web sign-in is **Supabase PKCE + Google OAuth**, implemented in the BFF:

- `services/bff/server.ts:795` — `/auth/v1/token?grant_type=pkce`
- `services/bff/server.ts:796` — `/auth/v1/authorize`
- `services/bff/server.ts:665-668` — Google OAuth authorize/token/revoke with
  signed state cookies
- `services/bff/server.ts:221` — verifies the Supabase JWT via `/auth/v1/user`
- `services/bff/server.ts:1094-1095` — the BFF **mints the harness session
  itself** and sets the browser cookie, then 303s to the UI

So there is **no hosted-control-plane dependency** in the web path. A second,
separate email-OTP sign-in exists (`server/account-signin.ts:65,79,90`, wired
at `server/index.ts:14406`) for desktop/local-first use. It is not on the web
deployment path.

The Supabase project is `gtuajwdsdxfobzvijypp`. It also holds an unrelated
product's nine tables, so Relay writes stay strictly inside `app`/`history`/
`logs` and nothing assumes other schemas are empty.

### Architecture decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Host | One OCI instance + persistent block volume at `/data` | Simplest thing that works; split later if measured |
| CPU arch | **A1 ARM64, no fallback** | Cheapest RAM/GB; bladebro arm64 exists, treated as working |
| Shape target | `VM.Standard.A1.Flex`, 2 OCPU / 12 GB | Fits Always Free; Relay low, Chromium high, Parakeet moderate |
| Browser worker | Separate service, same VM | Already worker-shaped; movable by URL |
| Transcription | Out of scope | No server STT exists; macOS-native only (`src/lib/desktop.ts:36-41`) |
| Storage | SQLite stays the live store | Audit found no dead weight; measure first |
| Observability | Existing pruned NDJSON | 180-day retention already configured |
| Datacenter IP | Accepted for MVP | Bladebro flags it regardless of fingerprint; `BLADE_PROXY` is the documented remedy |

## OCI target (concrete)

- **Region:** `us-ashburn-1`. VCN `relay-vcn` (`10.0.0.0/16`), public subnet
  `relay-public-subnet` (`10.0.1.0/24`), internet gateway with a `0.0.0.0/0`
  route, SSH keypair held by the operator and never committed.
- **Instance:** A1 ARM64, Ubuntu 24.04 Minimal aarch64, on-demand, public
  IPv4. Boot volume OCI default (~46.6 GB); no extra block volume for MVP.
- **Current blocker:** Ashburn reports out of capacity for A1 in all three
  ADs. Recovery order: retry later → other regions (VCN work repeats) → only
  with explicit approval consider anything billable. **Do not create A2
  without approval** (currently ~$14.14/month compute + $2/month boot volume).
- **Remote-host config (not code):**
  - Security list ingress on **80 / 443 / 22** (default list does not include
    all of these).
  - Caddy for TLS. Note `compose.yaml:43-46` refuses `OMB_HTTPS_HOST` unless
    `OMB_BIND_ADDRESS=127.0.0.1` — TLS terminates at Caddy in front of a
    loopback-bound app. TLS is mandatory for login, not cosmetic: cookies get
    `Secure` only under https (`services/bff/server.ts:513-515`).
  - `OMB_PUBLIC_URL` = the public https origin. `compose.yaml:19` still
    defaults to `http://localhost:...` — do not ship that. The OAuth check
    (`services/bff/server.ts:676`, `redirectUri.origin !== publicUrl.origin`)
    enforces consistency with the registered Google redirect URIs.
  - Google OAuth client + Supabase Auth Site/Redirect URLs must allow-list the
    VM hostname.
  - `RELAY_BFF_PUBLIC_URL` = the public BFF origin (dev uses a localhost
    value; do not ship that).
  - `OMB_LOOPBACK_TRUST=service` (`server/request-auth.ts:108,116-118`) so no
    network request is ever trusted as the owner.
  - Leave `RELAY_SHARED_WORKSPACE` unset (defaults to the shared
    Scout/Mercury/Curator roster, `server/relay-agents.ts:58-63`).
  - All other secrets via environment on the host, never in git. See
    `.env.example` for the full list.
- **Cost control:** no billable compute without approval; prefer Always Free;
  monitor Cost Analysis after deployment. Costs here are personally
  reimbursed, so the rule is explicit: if PAYG is ever considered, verify the
  deployed resources still sit inside the free allocation first.

## Phase 0 — Foundation

Ordered so each step unblocks the next. Steps 1–3 are code; 4–8 are
provisioning and verification on the host.

1. **Create `deploy/local/Dockerfile` and `deploy/local/Caddyfile`.** ✅ Done:
   `deploy/local/Dockerfile`, `deploy/local/Caddyfile`, and `compose.yaml:3-98`
   (omb/tools/caddy) exist.
2. **Add the Tool Layer as a compose service**, pointed at by
   `RELAY_TOOL_URL`, keeping `BLADE_HOME` under `/data` so browser state lives
   on the volume. ✅ Done: `compose.yaml:31-55`.
3. **Provision Chrome in the image**, then set `CHROME_PATH`. The image
   deliberately ships no browser (`Dockerfile:56-58`); Chrome system libraries
   are already present. Linux headful also needs Xvfb. (Tracked deferral in
   `plans/deferred.md:19`.)
4. **Provision the A1 instance** per the OCI section above; mount the
   persistent volume at `/data`. `OMB_DATA_DIR=/data/.openmausbot` and
   `HOME=/data` are already the image defaults (`Dockerfile:63-64`).
5. **Network + TLS + redirects + secrets** per the remote-host checklist.
6. **Confirm decision-log retention** (180 days) and size the volume for
   `decisions/`, `messages.db`, `attachments/`, and `task-workspaces/`.
7. **ARM gate:** run `bladebro audit` on the A1 host, then one real browser
   operation end to end —

   ```
   Bladebro → Chrome → real page → successful extraction
   ```

   `bladebro` publishes a Linux ARM64 build (`bladebro-linux-arm64`,
   cross-compiled, CI-green). Upstream marks it not-live-verified, but it
   exists, so it is treated as working: the audit plus one real extraction
   is the acceptance, not a separate browser-architecture test.

## Phase 1 — Thread ownership (build)

Starts only once the Phase 0 path is green.

Today ownership is **derived, not owned**:

- `messageSender` (`server/index.ts:809`) returns `undefined` for any
  non-session auth, so desktop/loopback sends carry no sender at all
- `threadActorContext` (`server/index.ts:821`) scans the transcript backwards
  for the last user message's sender, then falls back to routine owners that
  are themselves optional
- there is no `threadId → userId` table anywhere

With real users on a VM, "whose thread is this" has no reliable answer.

**Build:** a server-owned `thread_owners` mapping (`threadId → userId`),
written **only** from `auth.session.userId` at send time, never from model
input. Establishes:

```
Supabase user → actor.userId → thread.ownerUserId → routine.ownerUserId → browser workspace
```

and gives `threadActorContext` a source of truth instead of a backwards scan.
Note the durable consequence: `history.conversations.user_id` is `uuid not
null` and nothing currently writes that table, so any future transcript
mirroring depends on this existing.

## Phase 2 — Report download (done: soul guidance, no new route)

The only product gap between "works on the VM" and "usable remotely" turned
out to need no new infrastructure. Verified live 2026-10-05: Scout's
`attach_file` tool already accepts working-folder paths (task cwd is an
allowed root via `messageFileRootsForThread`), the server copies into the
attachment store, `POST /api/threads/:id/messages/:id/file` serves bytes
under message-grant auth, and `AttachmentGallery` renders the download link.
A 23 KB report round-tripped end to end on first asking.

The actual gap was behavioral: nothing told Scout to attach reports, so the
deliverable was a pasted filesystem path. Fixed in Scout's soul (seed in
`server/relay-agents.ts` plus the live record): *"When an investigation
produces a report file, attach it with attach_file so it appears in the chat
for preview and download; a filesystem path pasted as text is not a
deliverable."* Per-user private; sharing is download-and-send.

## Phase 3 — Deploy and smoke-test

- Restart survival (container + host reboot) with `messages.db` intact
- Multi-user session isolation — two users never see each other's threads
- Google sign-in through the BFF → harness session
- Supabase `app.*` write via `relay_write` (already verified working: a live
  insert round-tripped with `actor_user`, `actor_agent`, `source_url`,
  `confidence` set server-side)
- Scout tool calls end to end
- Browser session: `browser_open` / `browser_read` / `browser_extract`
- Report file downloadable through the Phase 2 route

## Phase 4 — Measure (drives Phase 5)

Only real usage answers these:

- SQLite size growth and write rate under actual conversation load
- Chromium RSS during Scout fan-out; whether parallel research jobs OOM
- A1 OCPU headroom, and whether a long running job starves the UI
- Whether Bladebro on an OCI IP gets blocked in practice, and how often
- Whether anyone actually needs cross-device history (→ justifies Phase 5)
- Whether multiple threads per bot are needed now (→ thread-list UI)
- Whether centralized tool logs earn their cost

## Phase 5 — Decide, from data

Storage: keep SQLite · add Postgres projection · full Postgres Store · async
Store rewrite.
Also: split the browser worker to its own VM · residential proxy ·
centralized observability · thread-list UI and thread navigation.

## Deferred, tracked

- **Parakeet 180M transcription.** No server-side STT exists today — no
  `/api/*transcribe*` route, no Parakeet reference. Dictation is macOS-native
  desktop-only (`src/lib/desktop.ts:36-41`, `engine: "apple-speech"`). Web
  users have no dictation at all. The `feature/meetings-agent` worktree has
  **zero unique commits and no Parakeet code**, so this is uncovered rather
  than in progress — and explicitly out of the MVP.
- **Thread navigation / list UI.** No back-to-main-chat affordance exists and
  `bot.tasks` has no primary marker, so "main chat" is not addressable in the
  data model. Removal artifacts of the old UI remain (`NewThreadButton`
  exported but unrendered, `revealThread` written but never read, ~15 orphaned
  `task.*` locale keys).
- **`logs.tool_calls` / `history.conversations`.** Both exist, neither has a
  writer in code. `logs.tool_calls` is in `DENY_ALL`; `history.conversations`
  declares `writable: []`. Filling them is a feature, not a gap.
- Chrome pin in the image (`plans/deferred.md:19` — partially addressed by
  Phase 0 step 3; the *pin* stays deferred).
