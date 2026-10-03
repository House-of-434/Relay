# Relay Tool Layer

The Tool Layer is the database security boundary. It binds to `127.0.0.1:8787`
and exposes exactly two MCP tools: `relay_read` and `relay_write`. Agent identity
comes from the configured MCP route (`/mcp/scout`, `/mcp/mercury`, or
`/mcp/curator`), never from tool arguments.

## Configuration

Copy `.env.example` to `.env`. `npm run dev` loads `../../.env.secrets` first and
this service's own `.env` second, so the shared values have a single home while
the service-role key stays only here. See `../../.env.secrets.example`.

- `RELAY_DB_URL`, `RELAY_DB_PROJECT_REF`, `RELAY_DB_SERVICE_ROLE_KEY` for
  Supabase project `434vc`.
- `RELAY_ALLOWED_EMAIL_DOMAINS` as a comma-separated allowlist for verified
  email metadata used by direct bearer-user authentication and signed harness
  actor assertions.
- `RELAY_TOOL_ACTOR_SECRET` and `RELAY_BFF_CAPABILITY`, each at least 32 bytes,
  shared with the chat harness and the BFF through `../../.env.secrets`. The actor
  secret verifies harness assertions; the capability authorises this service to
  ask the BFF to run an agent Gmail operation.
- Optionally, `RELAY_BFF_INTERNAL_URL`, defaulting to `http://127.0.0.1:8798`.
- Optionally, `NEWSLETTER_READONLY_URL`, `NEWSLETTER_READONLY_PROJECT_REF`, and
  `NEWSLETTER_READONLY_KEY` for the separate read-only newsletter project.
- `RELAY_TOOL_PORT` defaults to `8787`.

Each Supabase URL is checked against its configured project ref. Startup fails
if the Relay database cannot access `app.companies`. Newsletter tables remain
unavailable until their per-table column shapes are configured; access fails
closed rather than guessing columns.

Conversation history is readable by every agent and writable by none: a
conversation belongs to the authenticated user, so `read` is scoped to the
caller's own `user_id` and refuses to run without an authenticated actor.

The BFF verifies Supabase identity and issues a Relay session through the
internal portal-session route. That session's UUID `userId` is the account
identity; its email remains sender/contact metadata. For the matching Relay MCP
route, the harness signs `userId`, email metadata, and issued-at into the
`x-relay-actor-user` assertion. The Tool Layer verifies its HMAC and five-minute
clock window, validates the UUID and allowed email domain, then uses only the
UUID for ownership. Supabase JWTs are not forwarded into the harness or agents,
and agent tool arguments cannot select actor identity. Direct bearer-user calls
are verified with Supabase Auth and likewise resolve to the verified user's
UUID.

`POST /approve` is separate from MCP and requires a Supabase `Authorization:
Bearer …` token; it only approves/rejects a pending suggestion owned by that
verified user's UUID.

## Supabase migrations

The baseline SQL templates in `supabase/migrations/0001_init.sql` and
`0002_stores.sql` use Supabase JWT subject UUIDs for ownership and RLS. They are
ready for review before you run them in Supabase project `434vc`; these templates
have not been applied. They are updated as initial baselines and contain no
historical email-to-UUID backfill. No migration SQL is run by the Tool Layer.

Entity insert/update writes create a provenance receipt in the same database
transaction. After a capture insert, the Tool Layer calls a locked database
function that counts distinct `(source_type, url)` pairs and activates a
suggestion when at least two independent sources exist.

## Development

```sh
cd tools
pnpm install
pnpm test
pnpm typecheck
RELAY_DB_URL=... RELAY_DB_PROJECT_REF=... RELAY_DB_SERVICE_ROLE_KEY=... pnpm dev
```

Never put database credentials in chat configuration, tool arguments, or git.
