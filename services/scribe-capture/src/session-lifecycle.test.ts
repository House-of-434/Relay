/** Session lifecycle without a browser: boot identity and room-dedup selection.
 * join() itself always starts a real browser session, so the duplicate wiring
 * is covered through selectRoomDuplicate plus harness-level handling. */
import assert from "node:assert/strict";
import test from "node:test";

import { WORKER_BOOT_ID } from "./boot.js";
import { workerConfig } from "./config.js";
import type { IngestClient } from "./ingest-client.js";
import { selectRoomDuplicate, SessionController, voiceIdleExpired } from "./session.js";

const ENABLED = () => ({ ...workerConfig({ RELAY_SCRIBE_ENABLED: "1" } as NodeJS.ProcessEnv), workerCapability: "test-capability-that-is-long-enough-000000" });

test("a booted controller sweeps orphaned live rows once, before the first join", async () => {
  const reasons: string[] = [];
  const ingest = {
    async sweep(reason: string) { reasons.push(reason); return { swept: 2 }; },
    async post() { return { meeting_id: "m", upserted: 0 }; },
  } as unknown as IngestClient;
  const controller = new SessionController(ENABLED(), ingest);
  // Non-provider host: rejects without launching a browser.
  const first = await controller.join({ instance_id: "i-1", platform: "google_meet", meeting_url: "https://example.com/x" });
  assert.equal(first.status, "failed");
  assert.equal(reasons.length, 1);
  await controller.join({ instance_id: "i-2", platform: "google_meet", meeting_url: "https://example.com/y" });
  assert.equal(reasons.length, 1, "the sweep runs once per worker generation");
});

test("a failed sweep is retried on a later join, not memoized", async () => {
  let calls = 0;
  const ingest = {
    async sweep() { calls += 1; if (calls === 1) throw new Error("ECONNREFUSED"); return { swept: 0 }; },
    async post() { return { meeting_id: "m", upserted: 0 }; },
  } as unknown as IngestClient;
  const controller = new SessionController(ENABLED(), ingest);
  const descriptor = { instance_id: "i-1", platform: "google_meet" as const, meeting_url: "https://example.com/x" };
  await controller.join(descriptor);
  assert.equal(calls, 1);
  await controller.join({ ...descriptor, instance_id: "i-2" });
  assert.equal(calls, 2, "a failed sweep is retried");
});

test("voiceIdleExpired ends quiet rooms and silent waits", () => {
  const started = 1_000_000;
  // Recent voice: stay.
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: started + 10_000, lastVoiceAt: started + 100_000, now: started + 200_000 }), false);
  // 3 minutes without voice after speech: leave.
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: started + 10_000, lastVoiceAt: started + 10_000, now: started + 10_000 + 180_000 }), true);
  // Boundary: just under 3 minutes stays.
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: started + 10_000, lastVoiceAt: started + 10_000, now: started + 10_000 + 179_999 }), false);
  // Never any voice: 5-minute grace for others to arrive, then leave.
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: null, lastVoiceAt: null, now: started + 299_999 }), false);
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: null, lastVoiceAt: null, now: started + 300_000 }), true);
});

test("worker boot id is a stable uuid", () => {
  assert.match(WORKER_BOOT_ID, /^[0-9a-f-]{36}$/);
});

test("a real controller reports its boot id on unknown sessions", async () => {
  const controller = new SessionController({
    ...workerConfig({} as NodeJS.ProcessEnv),
    workerCapability: "test-capability-that-is-long-enough-000000",
  });
  const first = await controller.status("missing");
  const second = await controller.status("missing");
  assert.equal(first.status, "unknown");
  assert.equal(first.worker_boot_id, WORKER_BOOT_ID);
  assert.equal(second.worker_boot_id, WORKER_BOOT_ID);
});

test("stopping an unknown instance reports unknown", async () => {
  const ingest = {
    async sweep() { return { swept: 0 }; },
    async post() { return { meeting_id: "m", upserted: 0 }; },
  } as unknown as IngestClient;
  const controller = new SessionController(ENABLED(), ingest);
  assert.equal((await controller.stop("missing")).status, "unknown");
});

test("selectRoomDuplicate returns the live instance for a room", () => {
  const key = "google_meet|meet.google.com/abc";
  const sessions = [
    { instanceId: "old", live: false, urlKey: key },
    { instanceId: "live", live: true, urlKey: key },
    { instanceId: "other", live: true, urlKey: "google_meet|meet.google.com/xyz" },
  ];
  assert.equal(selectRoomDuplicate(sessions, key), "live");
  assert.equal(selectRoomDuplicate(sessions, "google_meet|meet.google.com/xyz"), "other");
  assert.equal(selectRoomDuplicate(sessions, "google_meet|meet.google.com/none"), null);
  assert.equal(selectRoomDuplicate(sessions, null), null);
  assert.equal(selectRoomDuplicate([{ instanceId: "done", live: false, urlKey: key }], key), null);
});

test("voiceIdleExpired needs a full quiet window", () => {
  const started = 2_000_000;
  // Voice 10s ago, now 2m59s later: stay.
  assert.equal(voiceIdleExpired({ captureStartMs: started, firstVoiceAt: started + 5_000, lastVoiceAt: started + 5_000, now: started + 184_999 }), false);
});
