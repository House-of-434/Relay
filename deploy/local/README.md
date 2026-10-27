# Local / single-VM deployment (Cloud MVP)

Runs Relay (harness + BFF), the Tool Layer (Bladebro + Chrome), and Caddy on
one host via Docker Compose. SQLite lives on a persistent Docker volume.
Supabase provides auth and the shared `app.*` knowledge base.

> **MVP persistence is SQLite on the persistent `/data` volume. Migration to
> Supabase/Postgres is planned before treating this deployment as production
> durable storage.** There is deliberately no backup/recovery project for the
> MVP — that is infrastructure creep against a store slated for migration.

## Prerequisites

- Docker Engine + Compose plugin on the host (x86_64 or ARM64).
- A public hostname pointing at the host (required: login needs Secure
  cookies, which need HTTPS).
- Supabase project with Auth + the `app` schema migrated
  (`supabase/migrations/0001_init.sql`, `0002_stores.sql`), and the
  `app`/`logs`/`history` schemas exposed to PostgREST.
- Google OAuth client (for Supabase Google sign-in) with the redirect URI
  below registered.

## Configure

```sh
cp .env.example .env        # then fill in every value
touch .env.secrets          # RELAY_TOOL_ACTOR_SECRET (>= 32 bytes) lives here
```

Required for the deployment (see `.env.example` for the full list):

| Variable | Value on the host |
|---|---|
| `RELAY_PUBLIC_URL` | `https://<public-hostname>` — never localhost; the OAuth check enforces it |
| `RELAY_BFF_PUBLIC_URL` | `https://<public-hostname>` (same origin; BFF is behind Caddy) |
| `RELAY_HTTPS_HOST` | `<public-hostname>` (Caddy automatic HTTPS) |
| `RELAY_BIND_ADDRESS` | `127.0.0.1` (compose refuses `RELAY_HTTPS_HOST` otherwise; TLS terminates at Caddy) |
| `RELAY_LOOPBACK_TRUST` | `service` (required) — a local request without a session gets client-level service access only, never owner privileges |
| `SUPABASE_PROJECT_URL` / `SUPABASE_ANON_KEY` | From the Supabase dashboard |
| `RELAY_BFF_CAPABILITY` | Shared BFF capability (see `.env.example`) |
| `RELAY_PORTAL_SESSIONS` | `1` — the BFF owns sign-in here; without it the harness refuses the session bridge and login fails |
| `RELAY_DB_URL` / `RELAY_DB_PROJECT_REF` / `RELAY_DB_SERVICE_ROLE_KEY` | Tool Layer database access |
| `RELAY_TOOL_ACTOR_SECRET` | In `.env.secrets`; must match between harness and Tool Layer |
| `RELAY_ENGINES` | Space-separated npm packages for the engine CLIs baked into the image (e.g. `@anthropic-ai/claude-code`) |
| `RELAY_DEFAULT_MODEL` | Centralized default model every new bot inherits (e.g. `claude-haiku-5-5`); `RELAY_DEFAULT_INSTANCE` overrides the instance id (default `claude`) |

> **Local development:** the browser path always carries a BFF session, so
> `service` changes nothing there. Only a developer who deliberately hits the
> harness directly at `127.0.0.1:8799` without a session would notice; they may
> set `RELAY_LOOPBACK_TRUST=owner` in a private environment they fully control.
> Never do that on a shared host: any local process (a bot's shell, another
> container) would then be the workspace owner.

Supabase dashboard side: Site URL + Additional Redirect URLs must allow-list
the public hostname, and the Google OAuth client must register
`https://<public-hostname>/api/google/oauth/callback`.

### Lock down sign-ups

Public sign-up must be closed to non-company addresses before the host is
reachable. Run `supabase/migrations/0010_allow_second_signup_domain.sql` in the
SQL Editor (it supersedes `0005_restrict_signup_domain.sql`), then wire the hook: **Authentication → Hooks → Before User
Created → Postgres function → `hook_restrict_signup_domain`**. Confirm with
`select proname from pg_proc where proname = 'hook_restrict_signup_domain';`
(one row), then call the sign-up endpoint with the anon key and confirm an
`@houseof434.com` and an `@434vc.com` address pass while a non-company
address returns the 400 message.

## Build and run

```sh
deploy/local/up.sh            # build, up -d, verify caddy's network attachment
deploy/local/up.sh --no-build # config/.env change only
```


Caddy serves `:80` and, with `RELAY_HTTPS_HOST` set, `:443` with automatic
HTTPS. The app proxies `/auth/*`, `/api/*`, and
`/.well-known/relay/*` to the BFF (`:8798`) and everything else (static
UI) to the harness (`:8799`) — same split as the dev Vite proxy.

## Verify the browser gate

```sh
docker compose exec tools bladebro --version
docker compose exec tools bladebro audit
```

`bladebro audit` (61 checks + cross-restart drift stamp) plus one real
extraction through Scout is the ARM64 acceptance for Bladebro — not a
separate architecture test.

## Operate

```sh
docker compose logs -f app tools   # follow logs
docker compose restart tools       # bounce the browser worker
docker compose down                # stop (volume `data` persists)
```

Data lives in the `data` volume. The Compose project is `relay`; containers are
`relay-*` and the persistent volumes are `relay_data`, `relay_scribe_data`,
`relay_caddy_data`, and `relay_caddy_config`. The data volume survives
`docker compose down`; only `docker volume rm` destroys it.

Existing hosts that still use the older `openmausbot` Compose project must copy
its volumes to the `relay_*` names once, before starting the renamed project:

```sh
docker compose -p openmausbot down
docker volume rm relay_data relay_caddy_data relay_caddy_config 2>/dev/null || true
copy_volume() {
  docker run --rm -u 0 --entrypoint sh -v "$1":/from -v "$2":/to relay-local:latest -c "cp -a /from/. /to/"
}
copy_volume openmausbot_data relay_data
copy_volume openmausbot_scribe_data relay_scribe_data
copy_volume openmausbot_caddy_data relay_caddy_data
copy_volume openmausbot_caddy_config relay_caddy_config
```

Set `COMPOSE_PROJECT_NAME=relay` and `RELAY_LOCAL_IMAGE=relay-local:latest` in
`.env`, tag or rebuild the image, then start `docker compose up -d`. Verify the
container mounts and health before removing the old volumes.

- `/data/.relay/users/<supabase-uid>/workspaces/<botId>` — an owned bot's
  shared working folder and memory.
- `/data/.relay/users/<supabase-uid>/threads/<botId>/<threadId>` — files for
  one conversation.
- `/data/.relay/attachments` — the shared, UUID-addressed attachment store.
  Uploaded files, generated files, and `attach_file` copies live here so chat,
  email, and every bot reference one file.
- `/data/.relay/bots/<botId>` — app-managed bot profile mirrors. Bots remain
  shared application records, not per-user folders.
- `/data/blade/<supabase-uid>` — Bladebro's per-user browser profile and
  artifacts.

Legacy `workspaces/` and `task-workspaces/` are not used by owned bots after
the user-scoped release. Archive them once the new build is running:

```sh
docker compose stop app
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose run --rm --no-deps --entrypoint sh app -lc \
  "mkdir -p /data/.relay/_legacy-$stamp && mv /data/.relay/workspaces /data/.relay/task-workspaces /data/.relay/_legacy-$stamp/"
docker compose start app
```

The server clears stale legacy task-folder paths on boot, so existing test
threads start in their new user-scoped folder. Leave `attachments/` and
`bots/` in place. Delete `_legacy-*` after the test data is no longer useful.

### Disk maintenance

Check what Docker is using before removing anything:

```sh
docker system df -v
docker buildx du
df -h /
```

Build cache is safe to prune and is the largest reclaimable item:

```sh
docker builder prune --all --force
docker buildx prune --all --force
docker system df
df -h /
```

Do not run `docker system prune -a --volumes`; it can remove rollback images
and volumes. Re-run the prune after the final image build so the build does
not immediately repopulate the cache.

### Resource samples

`deploy/local/sample-resources.sh` writes one TSV row per run with load,
memory, swap, disk, per-container CPU/memory, restart count, and OOM state.
Run it every five minutes with the bundled timer:

```sh
sudo cp deploy/local/relay-resources.service deploy/local/relay-resources.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relay-resources.timer
```

Cron is equivalent if the host has it:

```cron
*/5 * * * * /home/ubuntu/Relay/deploy/local/sample-resources.sh
```

Rotate the log with `deploy/local/relay-resources.logrotate`:

```sh
sudo cp deploy/local/relay-resources.logrotate /etc/logrotate.d/relay-resources
```

Use the samples to compare idle, one Scribe capture, one heavy agent run, and
both at once. The default file is `/var/log/relay-resources.tsv`; override it
with `RELAY_RESOURCE_LOG`.

## Services

| Service | Runs | Reachable as |
|---|---|---|
| `relay` | Harness `:8799` + BFF `:8798` (must share localhost — the BFF hardcodes the harness at `127.0.0.1`) | Caddy `:80`/`:443` |
| `tools` | Tool Layer `:8787` (Bladebro + Chrome) | `http://tools:8787` from `relay` only; not published |
| `caddy` | TLS + reverse proxy | Shares `relay`'s network namespace |

Gmail/Calendar tools in `tools` call the BFF's capability-gated
`/api/internal/*` routes at `http://app:8798` (compose sets
`RELAY_BFF_INTERNAL_URL`, and the BFF binds `RELAY_BFF_HOST=0.0.0.0`; the port
is never published, so only compose-network peers can dial it).

The Tool Layer listens on `0.0.0.0` here (`RELAY_TOOL_HOST`) because the
harness reaches it over the compose network. Bare processes keep the
`127.0.0.1` default. The HMAC actor assertion is the real boundary either way.

## Scribe (meeting capture)

Two more services, both compose-network only (no published ports):

| Service | Runs | Reachable as | Data |
|---|---|---|---|
| `scribe` | Capture worker (`:8791`): joins relay@'s meetings, taps meeting audio, writes rows via the Tool Layer | `http://scribe:8791` from `app`/`tools` only | `scribe_data` volume at `/data` (signed-in profile, spool, failures, probes) — mounted ONLY here |
| `stt` | Shared Parakeet int8 STT server (`:8090`), 16 kHz WAV → text | `http://stt:8090` from `scribe` only | model baked into the image |

Capabilities live in their own gitignored files (see
`.env.ingest.example` / `.env.scribe.example` / `.env.workspace.example`):

```sh
cp .env.ingest.example .env.ingest   # RELAY_INGEST_CAPABILITY (tools + scribe)
cp .env.scribe.example .env.scribe   # RELAY_SCRIBE_WORKER_CAPABILITY (app + scribe)
cp .env.workspace.example .env.workspace # RELAY_GITHUB_WORKSPACE_TOKEN (app only)
```

The `scribe` container holds **only** the ingest and scribe files; `app` holds the worker
capability and the GitHub workspace token; `tools` holds the ingest capability. The harness monitor arms
captures by calling the worker at `RELAY_SCRIBE_WORKER_URL` (`http://scribe:8791`).
`RELAY_SCRIBE_ENABLED` gates the whole feature.

Diagnostic retention defaults to **30 days** and sweeps `/app/storage/screenshots`,
`/data/scribe/failures`, `/data/scribe/status`, and `/data/scribe/probes`.
It never removes the persistent browser profile, the spool, or active capture
data. Set `RELAY_SCRIBE_RETENTION_MS` to override the window.

### One-time browser logins (on the host that runs `scribe`)

Providers bind sessions to egress IP, so logins must happen **in this compose
host/container**, never copied from a laptop, and **headful** under Xvfb (the
image ships Xvfb; `start-scribe.sh` runs the display). Two independent sessions
live in the `scribe_data` volume's profile:

- **relay@ (Google) — required for Meet.** Run a headful Chromium on the worker
  display, expose VNC on loopback (`x11vnc -display :99 -localhost -rfbport
  5901`), tunnel to it, sign in as relay@ (Workspace + 2FA), open Meet once,
  then **close the browser gracefully** (a `kill -9` does not flush the profile
  and the session is lost).
- **Zoom — required for Zoom.** Same profile, sign in at `zoom.us/signin`,
  preferably **Sign in with Google** with the same account. Zoom's web client
  walls anonymous/automated joins ("automated bots aren't allowed … must use
  Zoom RTMS") and it **detects a headless browser**, so it needs both a
  signed-in session AND a headful browser. With both, the bot joins as the
  account identity.

Full steps: `plans/scribe-stt.md` §7.

### Deploy order (feature is off by default)

1. Bring up the Tool Layer with the ingest route first (`tools` gains
   `.env.ingest`): `deploy/local/up.sh --no-build` (never name a subset that
   includes `app` but not `caddy` — see Build and run).
2. Build and start the worker + STT with the feature OFF so nothing arms:
   `RELAY_SCRIBE_ENABLED=0 deploy/local/up.sh`.
3. Verify: `docker compose exec scribe curl -sf http://127.0.0.1:8791/healthz`,
   `docker compose exec stt curl -sf http://127.0.0.1:8090/health`, the one-time
   login, then a manual `POST /join` (bearer from `.env.scribe`) against a test
   meeting and read the rows back.
4. Rehearse (reschedule/cancel/kill-mid-meeting), then set
   `RELAY_SCRIBE_ENABLED=1` and flip the prompt line.

### Image notes

- `scribe` bakes Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`);
  `RELAY_SCRIBE_MEM_LIMIT` (default `4g`) bounds a runaway Chrome. CPU is the
  tighter limit on a 2 vCPU host — measure before raising `RELAY_SCRIBE_MAX_CONCURRENT`.
- `stt` downloads the Parakeet TDT 0.6B v2 int8 model (~480 MB) at build; override
  the `MODEL_URL` build arg to change/pin it. Attribution: `deploy/local/STT-NOTICE.md`.
