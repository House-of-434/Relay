/**
 * Live harness-side driver for the Scribe monitor (dev tool).
 *
 * Runs the REAL ScribeMonitor against a remote BFF (calendar list) and worker
 * (/join, /status) reached over SSH tunnels, so scheduling/arming can be tested
 * without deploying the harness. Receipts are in-memory (a restart re-arms; fine
 * for a test). Env (all values supplied by the caller, never logged):
 *   RELAY_BFF_INTERNAL_URL           e.g. http://127.0.0.1:18798 (BFF direct)
 *   RELAY_BFF_CAPABILITY             BFF internal capability
 *   RELAY_TOOL_ACTOR_SECRET          actor-assertion HMAC secret
 *   RELAY_MAILBOX_ADDRESS/USER_ID    relay@ identity (the calendar owner)
 *   RELAY_SCRIBE_WORKER_URL          e.g. http://127.0.0.1:18791
 *   RELAY_SCRIBE_WORKER_CAPABILITY   worker endpoint capability
 * Run: node --experimental-strip-types scripts/scribe-monitor-live.ts
 */
import { ScribeMonitor, scribeMonitorConfig } from "../server/scribe-monitor.ts";
import { createCalendarEventLister } from "../server/scribe-calendar.ts";
import { createWorkerJoinClient, createWorkerStatusClient } from "../server/scribe-worker-client.ts";

const workerUrl = process.env.RELAY_SCRIBE_WORKER_URL ?? "http://127.0.0.1:18791";
const workerCap = process.env.RELAY_SCRIBE_WORKER_CAPABILITY;

const seen = new Map<string, string>();
const receipts = {
  has: (kind: string, key: string) => seen.has(`${kind}:${key}`),
  record: (kind: string, key: string, result: string) => { seen.set(`${kind}:${key}`, result); },
};

const cfg = { ...scribeMonitorConfig(), pollMs: Number(process.env.RELAY_SCRIBE_POLL_MS ?? 30_000) };

const monitor = new ScribeMonitor(
  {
    listEvents: createCalendarEventLister({ capability: process.env.RELAY_BFF_CAPABILITY, maxResults: cfg.maxResults }),
    joinWorker: createWorkerJoinClient({ url: workerUrl, capability: workerCap }),
    status: createWorkerStatusClient({ url: workerUrl, capability: workerCap }),
    receipts,
    selfAddress: process.env.RELAY_MAILBOX_ADDRESS,
    notify: async (n) => console.log("[notify]", JSON.stringify(n)),
    log: (msg) => console.log(new Date().toISOString(), msg),
  },
  cfg,
);

console.log(`[live] monitor starting; pollMs=${cfg.pollMs} worker=${workerUrl}`);
monitor.start();
process.on("SIGINT", () => { monitor.stop(); process.exit(0); });
process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
