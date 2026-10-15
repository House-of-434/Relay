/** Session lifecycle without a browser: boot identity and room-dedup selection.
 * join() itself always starts a real browser session, so the duplicate wiring
 * is covered through selectRoomDuplicate plus harness-level handling. */
import assert from "node:assert/strict";
import test from "node:test";

import { WORKER_BOOT_ID } from "./boot.js";
import { workerConfig } from "./config.js";
import { selectRoomDuplicate, SessionController, SoloWatcher } from "./session.js";

test("SoloWatcher fires after threshold consecutive solo polls", () => {
  const watcher = new SoloWatcher(3);
  assert.equal(watcher.observe(1), false);
  assert.equal(watcher.observe(1), false);
  assert.equal(watcher.observe(1), true);
});

test("SoloWatcher treats zero and resets on company", () => {
  const watcher = new SoloWatcher(2);
  assert.equal(watcher.observe(0), false);
  assert.equal(watcher.observe(0), true);
  const mixed = new SoloWatcher(2);
  assert.equal(mixed.observe(1), false);
  assert.equal(mixed.observe(4), false);
  assert.equal(mixed.observe(1), false);
  assert.equal(mixed.observe(1), true);
  mixed.reset();
  assert.equal(mixed.observe(1), false);
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
