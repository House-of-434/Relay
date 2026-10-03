# Relay — House of 434 AI Intelligence System

Relay is House of 434's internal intelligence workspace for researching
companies and people, recording sourced findings, handling a shared inbox, and
publishing a daily brief.

Open the hosted Relay app in your browser and sign in. This repository is the
app: conversation UI, agent harness, Tool Layer, and shared packages.

## Layout

```
Relay/
  src/                              # browser UI
  server/                           # agent harness (:8799)
  services/bff/                     # session + Google OAuth boundary (:8798)
  services/tool-layer/              # database security boundary (:8787, localhost-only)
  packages/relay-shared/            # shared agent roles and calendar types
  infra/                            # Caddy, systemd, Tailscale
  scripts/ public/ third_party/
```

## Target architecture

```
Users on House of 434 tailnet
             │
          Caddy
             │
    Relay app (:5199)
             │ local HTTP/SSE
    Harness (:8799)
      Scout | Mercury | Curator
             │ MCP/HTTP, agent-bound routes
    Relay Tool Layer (:8787, 127.0.0.1 only)
             │ PostgREST / service_role
    Supabase Postgres + pgvector + Storage
```

Agents reach the database only through the Tool Layer's `relay_read` and
`relay_write` tools. Agent identity comes from the configured MCP route
(`/mcp/scout`, `/mcp/mercury`, or `/mcp/curator`), never from tool arguments.

Set `RELAY_DISABLE_COMPUTER=1` in the server environment to disable computer,
browser, phone-tool, scheduled-call, and voice features at runtime.

## Agents

| Agent | MCP URL | Role |
|---|---|---|
| Scout | `http://127.0.0.1:8787/mcp/scout` | Research; on demand |
| Mercury | `http://127.0.0.1:8787/mcp/mercury` | Shared inbox; 15-minute poll and on demand |
| Curator | `http://127.0.0.1:8787/mcp/curator` | Read-only synthesis plus brief writes |

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

Copy `.env.example` to `.env` for local app settings. Copy
`services/tool-layer/.env.example` for the Tool Layer database credentials.
Shared secrets go in `.env.secrets` (never committed). See
`services/tool-layer/README.md` for the Tool Layer configuration.
