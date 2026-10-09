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
| `RELAY_LOOPBACK_TRUST` | `service` — no network request is ever trusted as owner |
| `SUPABASE_PROJECT_URL` / `SUPABASE_ANON_KEY` | From the Supabase dashboard |
| `RELAY_BFF_CAPABILITY` | Shared BFF capability (see `.env.example`) |
| `RELAY_PORTAL_SESSIONS` | `1` — the BFF owns sign-in here; without it the harness refuses the session bridge and login fails |
| `RELAY_DB_URL` / `RELAY_DB_PROJECT_REF` / `RELAY_DB_SERVICE_ROLE_KEY` | Tool Layer database access |
| `RELAY_TOOL_ACTOR_SECRET` | In `.env.secrets`; must match between harness and Tool Layer |
| `RELAY_ALLOWED_EMAIL_DOMAINS` | Allowed sign-in domains |
| `RELAY_ENGINES` | Optional: space-separated npm packages for engine CLIs the bots use |

Supabase dashboard side: Site URL + Additional Redirect URLs must allow-list
the public hostname, and the Google OAuth client must register
`https://<public-hostname>/api/google/oauth/callback`.

## Build and run

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose exec app curl -sf http://127.0.0.1:8799/api/health
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
docker compose logs -f relay tools   # follow logs
docker compose restart tools       # bounce the browser worker
docker compose down                # stop (volume `data` persists)
```

Data lives in the `data` volume (`/data/.relay` for the harness,
`/data/blade` for Bladebro). The volume survives `docker compose down`;
only `docker volume rm` destroys it.

## Services

| Service | Runs | Reachable as |
|---|---|---|
| `relay` | Harness `:8799` + BFF `:8798` (must share localhost — the BFF hardcodes the harness at `127.0.0.1`) | Caddy `:80`/`:443` |
| `tools` | Tool Layer `:8787` (Bladebro + Chrome) | `http://tools:8787` from `relay` only; not published |
| `caddy` | TLS + reverse proxy | Shares `relay`'s network namespace |

The Tool Layer listens on `0.0.0.0` here (`RELAY_TOOL_HOST`) because the
harness reaches it over the compose network. Bare processes keep the
`127.0.0.1` default. The HMAC actor assertion is the real boundary either way.
