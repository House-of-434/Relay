# Relay Tool Layer

The Tool Layer is the database security boundary. It binds to `127.0.0.1:8787`
by default (compose overrides the bind for the container network, where the
HMAC actor assertion below is the real boundary) and exposes `relay_read` and
`relay_write` on every MCP route (`/mcp/scout`, `/mcp/mercury`, or
`/mcp/curator`); agents with research capability additionally expose browser
and search tools to authenticated callers. Agent identity
comes from the configured MCP route, never from tool arguments. Every MCP
request requires an authenticated actor (verified Bearer user or signed
`x-relay-actor-user` assertion) and is rejected with 401 without one, because
the service-role credential bypasses Postgres RLS.

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
if the Relay database cannot access `app.companies`.

Reads are open to every agent; only writes are per-agent. `relay_read` takes
an explicit `select` list of allowlisted columns (no `select *`; each entry
must exactly match, so embedding and casts cannot smuggle) and parameterized
filters on shaped columns, applied with the client's `.eq()`/`.gte()` builders.
`email` on all five `public.*` tables is PII and supports exact match only, so
counts cannot binary-search addresses. `head:true` returns `{ total }` with no
`rows` key at all. Every result carries `{ rows, total, limit, offset,
nextOffset }` under the forced `(created_at desc, id asc)` order. Table names
are normalized before matching and the denylist (`logs.*`, `auth.*`,
`storage.*`, `vault.*`, `public.email_unsubscribe_tokens`) beats default-allow;
a routed-but-unshaped table still fails closed at the shape registry.

Conversation history is readable by every agent (scoped to the caller's own
`user_id` — a "how many chats" answer covers only the asker) and writable by
none. All `relay_read` and `relay_write` calls refuse to run
without an authenticated actor; entity writes additionally stamp
server-controlled provenance (`actor_user`, `actor_agent`).

Every read is audited to `logs.tool_calls` (migration `0004_read_audit.sql`)
with table, selected columns, filter keys (never values — values can be PII),
and row count. Reads that select `email` beyond 50 rows are flagged
(`flagged=true`) for review. Egress is a known residual risk: an agent with
web tools could exfiltrate rows it legitimately read via URL query strings; a
hard control there (blocking query strings matching just-read rows) is a
bigger follow-up project.

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

Model-controlled browser URLs are restricted to public `http(s)` hosts: the
Tool Layer refuses loopback, private, link-local, and cloud-metadata targets
(including numeric obfuscations). Redirect and DNS-rebinding containment inside
the headful browser belongs to the egress proxy allowlist (`BLADE_PROXY`).

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
