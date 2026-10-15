/** Session lifecycle without a browser: boot identity and room-dedup selection.
 * join() itself always starts a real browser session, so the duplicate wiring
 * is covered through selectRoomDuplicate plus harness-level handling. */
import assert from "node:assert/strict";
import test from "node:test";

import { WORKER_BOOT_ID } from "./boot.js";
import { workerConfig } from "./config.js";
import { selectRoomDuplicate, SessionController, SoloWatcher, soloPollAllowsLeaving } from "./session.js";
import { countMeetingPeople, describePeopleButtons, parsePeopleCount } from "../../../third_party/vexa-capture/core/meetings/modules/join/src/googlemeet/admission.js";

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

test("soloPollAllowsLeaving needs quiet solitude: audio or company vetoes", () => {
  // Quiet and alone three times in a row leaves.
  let watcher = new SoloWatcher(3);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), true);
  // Company resets, even mid-count.
  watcher = new SoloWatcher(3);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(4, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), false);
  assert.equal(soloPollAllowsLeaving(1, false, watcher), true);
});

test("soloPollAllowsLeaving: roster headcount vetoes a tile miss", () => {
  // The reported misfire: present-but-silent participant, unlabeled tile,
  // roster says 2. Silence is never evidence of absence — must never leave.
  const watcher = new SoloWatcher(1);
  for (let i = 0; i < 5; i++) {
    assert.equal(soloPollAllowsLeaving(1, false, watcher, 2), false);
  }
  // Roster agreeing solo still counts; absent roster falls back to tiles.
  const strict = new SoloWatcher(1);
  assert.equal(soloPollAllowsLeaving(1, false, strict, 1), true);
  const fallback = new SoloWatcher(1);
  assert.equal(soloPollAllowsLeaving(1, false, fallback, null), true);
});

test("parsePeopleCount reads roster numbers, ignores anything else", () => {
  assert.equal(parsePeopleCount("Show everyone, 2 people"), 2);
  assert.equal(parsePeopleCount("People (1)"), 1);
  assert.equal(parsePeopleCount("3"), 3);
  assert.equal(parsePeopleCount("1,234 people"), 1234);
  assert.equal(parsePeopleCount("People"), null);
  assert.equal(parsePeopleCount("Chat with everyone"), null);
  assert.equal(parsePeopleCount("Meeting ID 123-456"), null);
  assert.equal(parsePeopleCount(""), null);
  assert.equal(parsePeopleCount(null), null);
});

test("countMeetingPeople prefers aria-label, falls back to text, else null", async () => {
  const pageFor = (aria: string | null, text: string | null) => ({
    locator: () => ({
      first: () => ({
        isVisible: async () => true,
        getAttribute: async () => aria,
        textContent: async () => text,
      }),
    }),
  });
  assert.equal(await countMeetingPeople(pageFor("Show everyone, 2 people", null) as never), 2);
  assert.equal(await countMeetingPeople(pageFor(null, "People (1)") as never), 1);
  assert.equal(await countMeetingPeople(pageFor("People", "Chat") as never), null);
});

test("describePeopleButtons reports UI chrome only, capped", async () => {
  const page = {
    locator: (sel: string) => ({
      first: () => ({
        isVisible: async () => sel.includes("people"),
        getAttribute: async () => "Show everyone, 2 people",
        textContent: async () => "ignored",
      }),
    }),
  };
  const lines = await describePeopleButtons(page as never);
  assert.ok(lines.length >= 1 && lines.length <= 5);
  assert.ok(lines.every((line) => line.length <= 120));
  assert.ok(lines.some((line) => line.includes("Show everyone")));
});

test("soloPollAllowsLeaving: transmitting audio vetoes a tile miss", () => {
  // The reported misfire: present participant whose tile was not counted,
  // but whose audio flows. Must never leave.
  const watcher = new SoloWatcher(1);
  for (let i = 0; i < 5; i++) {
    assert.equal(soloPollAllowsLeaving(1, true, watcher), false);
  }
});

test("soloPollAllowsLeaving: unreadable tiles never count toward leaving", () => {
  const watcher = new SoloWatcher(1);
  for (let i = 0; i < 5; i++) {
    assert.equal(soloPollAllowsLeaving(0, false, watcher), false);
  }
});
