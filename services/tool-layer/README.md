# Relay Tool Layer

The Tool Layer is the database security boundary. It binds to `127.0.0.1:8787`
by default (compose overrides the bind for the container network, where the
HMAC actor assertion below is the real boundary) and exposes `relay_read` and
`relay_write` on every MCP route (`/mcp/scout`, `/mcp/mercury`, or
`/mcp/curator`); agents with research capability additionally expose browser,
search, and page-fetch tools to authenticated callers. Scout also exposes the arXiv and
SEC EDGAR research connectors as public built-ins (SEC requires its
fair-access User-Agent below), and the GitHub connector — repository search,
file reads, issues, and releases — only once the caller has connected a GitHub
installation; an unavailable connector has no reachable tool. Agent identity
comes from the configured MCP route, never from tool arguments. Every MCP
request requires a signed `x-relay-actor-user` assertion and is rejected with
401 without one, because the service-role credential bypasses Postgres RLS.

## Configuration

Copy `.env.example` to `.env`. `npm run dev` loads `../../.env.secrets` first and
this service's own `.env` second, so the shared values have a single home while
the service-role key stays only here. See `../../.env.secrets.example`.

- `RELAY_DB_URL`, `RELAY_DB_PROJECT_REF`, `RELAY_DB_SERVICE_ROLE_KEY` for
  Supabase project `434vc`.
- `RELAY_TOOL_ACTOR_SECRET` and `RELAY_BFF_CAPABILITY`, each at least 32 bytes,
  shared with the chat harness and the BFF through `../../.env.secrets`. The actor
  secret verifies harness assertions; the capability authorises this service to
  ask the BFF to run an agent Gmail operation.
- Optionally, `RELAY_BFF_INTERNAL_URL`, defaulting to `http://127.0.0.1:8798`.
- `RELAY_TOOL_PORT` defaults to `8787`.
- `RELAY_SEC_USER_AGENT` declares the SEC EDGAR fair-access identity (with
  contact information). SEC tools are unavailable until it is set.
- Optionally, `RELAY_ARXIV_USER_AGENT`, defaulting to a descriptive Relay value.

Each Supabase URL is checked against its configured project ref. Startup fails
if the Relay database cannot access `app.companies`. Public intake tables remain
unavailable until their per-table column shapes are configured; access fails
closed rather than guessing columns. Scout may read applications, invitation
requests, host applications, and partner inquiries. Mercury also gets newsletter
subscribers, suppressed emails, and the email send log. Curator gets none of the
public intake tables. They are read-only for every agent and returned newest
first, so `limit: 1` is the most recent row.

`app.events` is the House of 434 Event Content Tracker: `title`, `event_date`,
`hosted`, `city_state`, `event_url`, `speakers`, `media_url`,
`cover_image_url`, and `notes`. Only `title` is required; the sheet is the
source of truth and may not have a date or link yet. Link fields are validated
as http(s) URLs when supplied. The table carries no classification, research
provenance, or per-user ownership columns, and every signed-in member can read
every row.

`relay_write` calls to entity tables also record `table_name`, `operation`, and
the changed `row_id` in `logs.tool_calls`. The call arguments are still stored
only as a hash; the log identifies the row, never the values.

Every agent can call `find_teammate` to resolve a colleague's name or email to
an invitation address. The service-role-only `app.search_members` function
returns confirmed, active accounts' name and email only; multiple matches are
returned so the agent asks which person the user meant.

Conversation history is readable by every agent and writable by none: a
conversation belongs to the authenticated user, so `read` is scoped to the
caller's own `user_id`. All `relay_read` and `relay_write` calls refuse to run
without an authenticated actor; entity writes additionally stamp
server-controlled provenance (`actor_user`, `actor_agent`).

The BFF verifies Supabase identity and issues a Relay session through the
internal portal-session route. That session's UUID `userId` is the account
identity; its email remains sender/contact metadata. For the matching Relay MCP
route, the harness signs `userId`, the calling `agent`, email metadata, and
issued-at into the `x-relay-actor-user` assertion. The Tool Layer verifies its HMAC and five-minute
clock window, validates the UUID and allowed email domain, rejects the request
with 401 when the assertion's agent does not match the MCP route, then uses only the
UUID for ownership. Supabase JWTs are not forwarded into the harness or agents,
and agent tool arguments cannot select actor identity. Direct bearer-user calls
are verified with Supabase Auth and likewise resolve to the verified user's
UUID.

Model-controlled browser and web_fetch URLs are restricted to public `http(s)` hosts: the
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
