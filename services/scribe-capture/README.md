# @relay/scribe-capture

The Scribe capture worker. Slice 1 (Meet): a capability-authed endpoint that
joins a meeting as relay@, taps the remote audio, transcribes it, and writes
the meeting + segments to Supabase through the Tool Layer ingest route.

## Shape

```
monitor ──POST /join──▶ worker ──join (authenticated, persistent profile)──▶ Meet
                          │  in-page PCM tap ──▶ STT server ──▶ segments
                          └──POST /internal/transcripts──▶ Tool Layer ──▶ Supabase
```

- `POST /join` — idempotent by `instance_id`; returns immediately, capture runs
  in the background. A descriptor with `reject_reason` (or over capacity, or a
  non-provider host) writes a `failed` row without joining.
- `POST /status` / `POST /stop` — by `instance_id`.
- `GET /healthz` — no capability.

Auth: `Authorization: Bearer $RELAY_SCRIBE_WORKER_CAPABILITY`. No loopback
requirement; the capability is the boundary.

## Lifecycle (slice 1)

1. `join` → status `joining`.
2. Admitted → status `active`; meeting row written with `actual_start` = capture
   time zero.
3. Capture loop drains PCM every ~6s, transcribes, buffers.
4. Flush when 50 segments or 17.5s elapsed, whichever first.
5. On stop/end → final flush, `completed`; on error → `failed`; on live-meeting
   conflict → `skipped`.

The mixed lane writes `speaker: null`; the per-channel Meet lane binds the
resolved speaker name per channel.

## Run

```bash
# STT server (loads Parakeet int8 once)
RELAY_STT_MODEL_DIR=/data/scribe/parakeet python3 stt/parakeet_server.py &

# worker
RELAY_SCRIBE_PROFILE_DIR=/data/scribe/profile \
RELAY_INGEST_URL=http://127.0.0.1:8787/internal/transcripts \
RELAY_STT_URL=http://127.0.0.1:8090 \
pnpm --filter @relay/scribe-capture start
```

The persistent profile must be signed in as relay@ once (see
`plans/scribe-stt.md` §7). The worker never holds a database key or BFF secret.

## Landed since slice 1

The calendar monitor (`server/scribe-monitor.ts`), failure/ready notices, the
per-channel Meet lane, the compose `scribe`/`stt` services, and the
`.env.ingest` / `.env.scribe` capability wiring — deploy/run owner is
`deploy/local/README.md` (Scribe section). Remaining: Zoom/Teams capture
parity (the descriptor already carries `platform`; Meet is the proven path).
