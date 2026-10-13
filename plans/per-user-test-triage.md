# Per-user workspaces: test triage

Acceptance: the two-user isolation e2e (`server/per-user-isolation.e2e.test.ts`)
is green, and no test fails that passed before these changes except for the
deliberately removed flows listed below.

## Migrated (now passing as a signed-in owner)

The fixture (`launchVerificationServer`) and the `server/testing/owner.ts`
helper issue a real owner session; tests send its bearer. Seeded records carry
`ownerUserId`; the actor assertion carries owner/bot/thread.

Unit: `bot-visibility`, `peer-roster`, `chief-of-staff`, `relay-mcp`,
`store` (+ per-owner idempotency/retry), `request-auth` (service 404),
`config`, `package-export`, `package-import`, `presets`,
`tightening-requests`, `webhooks`, tool-layer (90), BFF (76).

Integration: `per-user-isolation` (new, 7), `decision-log-wiring`,
`digest`, `notification-wiring`, `hooks`, `branching`, `aside`,
`steer-unattended`, `post-to-room`, `steer-queue`, `thread-aware-bots`,
`comms`, `group-goal-run`, `group-goal-wait-cap`, `decider-included`,
`decider-rooms`, `room-chat-wait`, `claude-account-api`,
`cli-service-trust`, `usage-ledger-api`, `spend-cap-api`, `team-share`,
`team-setup`, `bot-deletion-write-failure`, `control-relay`,
`routes/bot-memory`, `command-allowlist`, `delta-context`,
`guarded-messages-api`, `new-bot-defaults`, `independent-threads-api`
(paired approval → owner session; profile PATCH → pinned task +
`updateBotDefault`), `chat-followups-restart` (paired device → owner;
restart re-issues owner via `prepareOwnerSession` +
`verificationServerEnvironment`; `via:api` dropped for owner sends),
`full-access-workflows` (restart uses `verificationServerEnvironment` +
owner re-issue), `shared-computers` (lender is owner; intruder is a
no-user session asserting 403/404 fail-closed), `admin-activity.e2e`
(sessions carry UUID `userId` so Boss/Ada own their bots; deleted
`/api/mcp/servers` assertions dropped with custom MCP; ADA pinned-PATCH
→ 404 non-owner; concurrent bot writes both Boss — loopback owns no bots;
`composio:false` → `hidden:true` since composio is dropped and new bots
already default `composio:false`).

## Deleted (feature deliberately removed)

- `bot-visibility.e2e.test.ts` — email audiences retired.
- `relay-agents.e2e.test.ts` — global boot seeding removed; per-owner seeding
  and idempotency are covered by `store.test.ts` and the isolation e2e.
- `verification-fixture.e2e.test.ts`, `control-relay` starter case —
  single starter-bot seeding removed.
- `paired-thread-targets-api.test.ts`, `steer-e2e.test.ts`,
  `card-answerers.e2e.test.ts`, `usage-attribution.e2e.test.ts`,
  `thread-owners.e2e.test.ts` — pairing/member authorship and the
  thread-owners map as an owner source are retired. Steering itself stays
  covered by `steer-queue`; owner answering by `decision-log-wiring`; per-user
  `user_id`/`owner_user_id`/`bot_id`/`thread_id` stamping by the tool-layer
  `security`, `database` and `actor-assertion` tests.
- `mcp-selection.e2e.test.ts`, `openai-tools.e2e.test.ts`,
  `mcp-registry.test.ts`, `src/lib/mcp-servers*` — custom MCP servers removed.
- `post-to-room` "room messages through the local API" describe —
  session-less sends now fail closed.

## Parked (fail on the pre-change commit for unrelated reasons)

Verified from a baseline run on HEAD: none of these failures involve the
owner gate, `ownerUserId`, or the actor assertion.

- Provider/driver env leakage: `drivers/acp/acp.test.ts`,
  `drivers/claude-accounts.test.ts`, `drivers/claude.test.ts`,
  `drivers/codex.test.ts` (`tts-should-not-leak`, `RELAY_TTS_KEY`, parent keys).
- Computer/phone/cloud features: `group-local-vm.e2e`, `surface-pins.e2e`,
  `phone-claim.e2e`, `phone-secret`, `cloud-home-server`,
  `cloud-lending.e2e`, `cloud-lending-memory.e2e`, `cloud-move.e2e`,
  `vps-computer`, `vps-routing`, `host-lazy-claim.e2e`, `remote-sessions`.
- Harness unit/integration (loopback/ownerless fixtures, skill library,
  sessions registry, backup): `index.test.ts`, `sessions.test.ts`,
  `skill-library.test.ts`, `team-backup.test.ts`,
  `workspace-backup-workflow.test.ts`, `admin-activity.e2e.test.ts`,
  `memory-layer.e2e.test.ts`, `notification-routing.e2e.test.ts`,
  `peer-allowlist.e2e.test.ts`, `cli.test.ts`.

## Remaining (needs per-file review)

- Unmigrated self-bootstrapping suites (spawn their own server on loopback):
  verified green as-is (scope-gated, not owner-gated): `chatgpt-plan-api`,
  `people-invite`, `legacy-migration`, `cli-probe-env`, `email-signin`,
  `boat-included`, `shared-computers.gate`. Chat/history
  (`chat-followups`, `independent-threads-api`), routines
  (`routine-continuity/cron/delegation/results`, `routines-startup`),
  approvals (`approval-mode`, `peer-approval`), memory/files
  (`memory-entries/journal/store/upkeep`, `attachments`, `bot-attachment`,
  `memory-routes`) all green. `memory-layer.e2e` still fails but parked:
  `PATCH {memoryUpkeep, browser:invalid}` expects 400, gets 200 — PATCH
  validation strictness, no owner/viewer/actor involved.
  `tsc -p tsconfig.server.json` and `oxlint` clean;
  `per-user-isolation` 7/7 green.

Root causes fixed in this batch (applies to remaining files):

- `PATCH /api/bots/:id {modelSelection}` on a multi-thread bot is 409
  (`requirePinnedClientThread`) for session callers. Use
  `PATCH /api/bots/:id/tasks/:taskId {modelSelection, updateBotDefault:true}`.
- Pairing sessions (`/api/auth/pairing` + `/api/auth/pair`) carry no user id
  and see nothing. Queue/read as the owner (`fixture.info.token`); assert
  intruders get 403 (scope) or 404 (ownership) — both fail closed.
- Manual restarts must use `verificationServerEnvironment(process.env,
  dataDir, port)` (carries `RELAY_TOOL_ACTOR_SECRET`) plus
  `registerOwnerFetch(url, prepareOwnerSession(dataDir))`.
- Owner sends have no `via:"api"` stamp (loopback-only). Drop `via` from
  owner-send expectations; sender is `{name: owner email, id: p_…,
  email, actorUserId}` — assert with `objectContaining({name})`.
