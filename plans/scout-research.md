# Scout Research — Architecture and Phase Status

Request-driven research for Relay. One Scout, multiple bounded research
tasks. Curator (or a user request) invokes Scout when a briefing or question
needs research; Scout plans the investigation, runs independent searches in
parallel, collects evidence with source links, and writes the report. No
separate orchestrator service, no permanent monitoring pool.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Browser engine | Bladebro, replacing agent-browser |
| Isolation key | `<userId>` — one workspace per user, shared by that user's agents |
| Security / stealth / proxy | Bladebro-owned via `BLADE_*`; Relay supplies a curated env |
| Search | TinyFish adapter behind a provider interface |
| Reddit OAuth | Deferred (see deferred.md) |
| Residential proxy | Deferred (see deferred.md) |
| Live view | In MVP (poll `bladebro vision`; CDP screencast later) |
| Claude tool restriction | Dropped — prompt only |
| Subagents | No — parallel MCP calls cover search fan-out |
| Connectors | Bladebro only for MVP (Reddit/X via saved logins) |
| Deployment / containerization | Out of scope; dev-only |
| Evidence table | Deferred — audit existing `app.*` first |
| Embeddings | Deferred |
| Research store | Shared org-wide, unchanged |

## Architecture

```
Scout (Claude Code CLI)
  └─ MCP http://127.0.0.1:8787/mcp/scout      existing, HMAC actor assertion
       └─ Tool Layer :8787                     existing DB security boundary
            ├─ relay_read / relay_write        unchanged, shared org store
            ├─ web_search                      new, Phase 4 (provider iface → TinyFish)
            └─ browser_open/_read/_extract     new, Phase 2 (Bladebro)
```

Scout holds no Bladebro handle, path, or env var. `browser_*` calls route
by `actor.userId` from the signed assertion — never from model tool
arguments, matching the existing `authorize()` discipline.

## Workspace isolation (tightening 1)

- `actor.userId` is the **sole** source of workspace identity.
- Canonicalized (lowercase) and validated (UUID) in
  `services/tool-layer/src/infra/workspace-identity.ts` before any path is
  built. Unauthenticated actors get no workspace (throw, fail closed).
- `BLADE_HOME=/data/blade/<userId>`. Profile, saved logins, learned domain
  knowledge, artifacts, and behavioral fingerprint all live underneath it.
- Model arguments can never select a user, path, daemon, or session: the
  browser tools take no such parameters.

## Browser lifecycle (tightening 2)

Policy lives in `services/tool-layer/src/infra/browser-lifecycle.ts`
(pure, tested offline); the adapter (`infra/bladebro.ts`) implements it:

- **Multiplexing by data root, not ports:** Bladebro keeps one daemon per
  BLADE_HOME behind a socket in that root (`cli.sock`) — spike-verified
  with concurrent homes, zero ports involved. An earlier port reservation
  (18600–18699) was removed: the CLI surface binds no ports, and forcing
  ports would require the forbidden `--host/--port` attach.
- **Concurrency:** same-user calls run fully parallel (Scout fan-out
  requires it). First-spawn races are serialized by Bladebro's native
  data-root lock (`cli.pid`, surfaced by `bladebro doctor`), not here.
- **Crash recovery:** native — the daemon self-heals dead refs/tabs and
  relaunches crashed Chrome; `bladebro stop` is graceful and idempotent.
- **Idle reclaim:** `BLADE_IDLE_RECLAIM_MS` (10 min, matches Bladebro's
  own default), lazy sweep per call; daemon ceiling `MAX_BLADE_DAEMONS =
  12` — refuse instead of exhausting the host.
- **Isolation:** lane left unset (Bladebro's default is the isolated agent
  browser); `real`, `attach`, `profile`, `--host/--port`, `rb`, `mcp`,
  and manual `daemon` control are forbidden argv and fail closed. Only
  `BLADE_ALLOWED_ENV` crosses into the daemon environment; HOME is
  contained to the workspace.

## Knowledge-base distinction (tightening 3)

| Data | Home | Visible to | Written by |
|---|---|---|---|
| Companies / people / events | Supabase `app.*` (shared org store, RLS `classification='internal'`) | every member | `relay_write` with `source_url` + `confidence` |
| Conversation history | `history.conversations` (RLS: own rows) | owning user | server only |
| Browser profile, saved logins | `BLADE_HOME/<userId>` | that user's agents only | Bladebro |
| Learned domain knowledge, fingerprint | `BLADE_HOME/<userId>` | that user's agents only | Bladebro |
| Page extracts, downloads | `BLADE_HOME/<userId>/artifacts` | that user's agents only | Bladebro |

Rules:

1. Nothing under `BLADE_HOME` is shared across users, ever.
2. Browser artifacts become organizational knowledge **only** through an
   explicit `relay_write` with `source_url` — never by path, import, or
   side effect. `artifactsDirFor` nests under the user's workspace root so
   extracts cannot land in (or be mistaken for) shared storage.
3. Session data (cookies, storage, logins) never leaves `BLADE_HOME`.
4. `relay_read` / `relay_write` semantics are unchanged (`authorize()`).

## Research workflow (Phase 5)

- Capability manifest in Scout's prompt (`server/relay-agents.ts` soul):
  what tools exist, what each is for, cost/latency — Scout selects
  autonomously, no hardcoded `relay_read`-first order.
- Quick vs deep = inline answer vs `start_thread` (durable id, own
  history, already built; max 5/turn, no recursion).
- Evidence assembly → `relay_write` with `source_url` + `observed_at` +
  `confidence`; verified / single-source / inference kept distinct.
- Deep-research fan-out uses parallel MCP calls, not subagents
  (`MAX_COMMS_DEPTH = 1` makes delegation a pipeline, not a pool).

## Curator routine (Phase 6)

`Routine.ownerUserId`/`ownerEmail`, set only from server-derived identity
at creation (confirming conversation's user via `ownerForThread`, or the
creating session on direct POST) — never from model input, patches, or
backups. `update()` preserves it; `cleanRoutineOwner` enforces
both-or-nothing canonical form.

At run time, `threadActorContext` falls back to the routine owner when a
thread has no user sender: directly for routine execution/results threads,
or one delegation hop away (`resolveRoutineOwner`, cycle-safe, depth-capped).
So Curator 8 AM → `delegate_bot` Scout → Scout's `browser_*` calls land in
the routine owner's workspace, and the live-frame poller follows the same
actor. `RoutineTarget = "bot"` + `delegate_bot` remain the only execution
mechanism; path proven by `routine-delegation.e2e.test.ts`.

## Phase status

| Phase | Status |
|---|---|
| 1 — Engine cleanup + CI repair + isolation/lifecycle foundation | done |
| 2 — Bladebro adapter + `browser_*` MCP tools | done |
| 4 — `web_search` provider interface + TinyFish adapter | done |
| 5 — Scout workflow (soul manifest, quick/deep) | done |
| 3 — Live browser view | done |
| 6 — Curator owner routing | **done (this change)** |
| 3 — Live view (`vision` polling) | after 2 |
| 4 — `web_search` provider interface + TinyFish adapter | after 2 |
| 5 — Scout workflow (soul manifest, quick/deep) | after 2+4 |
| 7 — Final acceptance | this change (checklist below) |

## Acceptance criteria (Phase 7)

Automated (CI green is the gate):

1. Cross-user isolation — `workspace-identity.test.ts`, `browser.test.ts`
   (distinct `BLADE_HOME`s over HTTP), `evals` isolation check.
2. Same-user sharing — one `BLADE_HOME` per user by construction
   (`workspaceRootFor` ignores agent); all agents of a user resolve it.
3. Search + browser agent-callable — `research.test.ts` chain
   (`web_search` → `browser_open` → `browser_read`/`extract`).
4. Honest failure — `blocked:` verdict surfaces, never fabricates
   (adapter + HTTP tests); `source_url`/`confidence` enforced on write.
5. No stale loops — poller self-stop unit-tested; idle reclaim + ceiling
   unit-tested; interrupt stops wired.
6. Tool surface — Scout lists 6 tools, Mercury/Curator see no
   search/browser; `authorize()` semantics unchanged.
7. Typecheck, lint, evals (offline + golden + live-skip) green.

Manual (host with Chrome + network):

8. `bladebro audit` passes on the target host.
9. Scheduled Curator routine → delegate Scout → Scout browses in the
   routine owner's workspace (check daemon `BLADE_HOME`, run a
   `browser_open`, confirm records land with the owner's `actor_user`).
10. Deep Research toggle → plan preview → confirm → background job →
    cited report; cancel path respected.
11. Normal research freely uses search/browser/link traversal inline.
12. Reddit `see extract=auto` returns the available comment tree with
    `fuzzed_score` where exposed; blocks report honestly.
13. No stray `bladebro daemon`/Chrome processes or polling after teardown
    (`ps`, idle reclaim).

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Datacenter IP reputation | High | `BLADE_PROXY` deferred, not forgotten |
| macOS/ARM binaries unverified | Medium | x86 host; pin version; keep `--rollback` |
| No CAPTCHA solving | Medium | `blocked:` verdict is honest |
| Daemon multiplexing | Low | data-root sockets, no ports; ceiling + idle reclaim enforced |
| Bladebro self-update in prod | Medium | `BLADE_NO_UPDATE_CHECK=1` |
| No domain allowlist | Accepted | unchanged; `allowedDomains` was never implemented |
| 4GB host vs 10 users | Medium | test on 4GB, size on measured peak concurrency |
