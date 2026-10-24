/** Worker environment contract.
 *
 * The worker holds only two secrets: RELAY_SCRIBE_WORKER_CAPABILITY (its own
 * endpoint) and RELAY_INGEST_CAPABILITY (to write transcripts through the Tool
 * Layer). It never holds BFF secrets or a database key.
 */

export interface WorkerConfig {
  host: string;
  port: number;
  /** Bearer for /join|/status|/stop. */
  workerCapability: string | undefined;
  /** Bearer for the Tool Layer ingest route. */
  ingestCapability: string | undefined;
  ingestUrl: string;
  /** Playwright persistent-context dir holding the signed-in Scribe profile. */
  profileDir: string;
  /** STT server base URL (transcribe endpoint appended). */
  sttUrl: string;
  /** Flush cadence: whichever comes first, N segments or this many ms. */
  flushSegments: number;
  flushMs: number;
  /** Concurrency cap; a meeting beyond this becomes failed "at capacity". */
  maxConcurrent: number;
  /** Action gate: /join is refused unless RELAY_SCRIBE_ENABLED=1. Default off,
   *  matching the harness monitor gate, so a stray join cannot capture merely by
   *  deploying the worker. */
  enabled: boolean;
  /** A meeting longer than this is force-ended (safety). */
  maxMeetingMs: number;
  /** Per-channel Meet lane: cap on concurrent speaker streams (each extra stream
   *  is another STT call site). */
  maxStreams: number;
  /** The bot's own display name, excluded from glow binding. */
  selfName: string;
  /** Run the browser headless. Set RELAY_SCRIBE_HEADLESS=0 to run headful under
   *  Xvfb — some providers (Zoom) detect headless and serve an anti-bot wall. */
  headless: boolean;
  /** GATE probe: run the per-channel Meet lane and write a naming artifact
   *  (also feeds the pipeline; skips ingest). */
  gmeetProbe: boolean;
  /** Directory for probe artifacts (privacy: VPS-local, never committed). */
  probeDir: string;
  /** Injected bundle for the per-channel Meet lane; default resolved next to src. */
  gmeetBundlePath: string | undefined;
  /** Injected bundle for the per-track Zoom lane; default resolved next to src. */
  zoomBundlePath: string | undefined;
  /** Scribe state root: spool, failures, status files, profile. */
  dataDir: string;
  /** Retention for failure screenshots and status files. */
  retentionMs: number;
  /** Warn when free space on the data volume drops below this. */
  diskMinBytes: number;
  /** Maintenance sweep interval. */
  maintenanceMs: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function workerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    host: env.RELAY_SCRIBE_HOST ?? "127.0.0.1",
    port: num(env.RELAY_SCRIBE_PORT, 8791),
    workerCapability: env.RELAY_SCRIBE_WORKER_CAPABILITY?.trim() || undefined,
    ingestCapability: env.RELAY_INGEST_CAPABILITY?.trim() || undefined,
    ingestUrl: (env.RELAY_INGEST_URL ?? "http://127.0.0.1:8787/internal/transcripts").trim(),
    profileDir: (env.RELAY_SCRIBE_PROFILE_DIR ?? "/data/scribe/profile").trim(),
    sttUrl: (env.RELAY_STT_URL ?? "http://127.0.0.1:8090").trim(),
    flushSegments: num(env.RELAY_SCRIBE_FLUSH_SEGMENTS, 50),
    flushMs: num(env.RELAY_SCRIBE_FLUSH_MS, 17_500),
    maxConcurrent: num(env.RELAY_SCRIBE_MAX_CONCURRENT, 2),
    enabled: env.RELAY_SCRIBE_ENABLED === "1",
    maxMeetingMs: num(env.RELAY_SCRIBE_MAX_MEETING_MS, 4 * 60 * 60 * 1000),
    maxStreams: num(env.RELAY_SCRIBE_MAX_STREAMS, 12),
    selfName: (env.RELAY_SCRIBE_SELF_NAME ?? "Relay Scribe").trim(),
    headless: (env.RELAY_SCRIBE_HEADLESS ?? "1") !== "0",
    gmeetProbe: (env.RELAY_SCRIBE_GMEET_PROBE ?? "0") === "1",
    probeDir: (env.RELAY_SCRIBE_PROBE_DIR ?? "/data/scribe/probes").trim(),
    gmeetBundlePath: env.RELAY_SCRIBE_GMEET_BUNDLE?.trim() || undefined,
    zoomBundlePath: env.RELAY_SCRIBE_ZOOM_BUNDLE?.trim() || undefined,
    dataDir: (env.RELAY_SCRIBE_DATA_DIR ?? "/data/scribe").trim(),
    retentionMs: num(env.RELAY_SCRIBE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000),
    diskMinBytes: num(env.RELAY_SCRIBE_DISK_MIN_BYTES, 1024 * 1024 * 1024),
    maintenanceMs: num(env.RELAY_SCRIBE_MAINTENANCE_MS, 60 * 60 * 1000),
  };
}
