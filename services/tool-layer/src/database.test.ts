import assert from "node:assert/strict";
import test from "node:test";

import { signActorAssertion } from "./infra/actor-assertion.js";
import { chooseMeetingCapture, nativeIdFromMeetingRef, RelayDatabase } from "./infra/database.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";

function database(overrides: Record<string, string | undefined> = {}): RelayDatabase {
  return new RelayDatabase({
    RELAY_DB_URL: "https://relay-test.supabase.co",
    RELAY_DB_PROJECT_REF: "relay-test",
    RELAY_DB_SERVICE_ROLE_KEY: "test-service-role-key",
    RELAY_TOOL_ACTOR_SECRET: SECRET,
    ...overrides,
  });
}

test("a signed harness actor assertion resolves to the owner, bot, and thread", () => {
  const db = database();
  const assertion = signActorAssertion({ userId: USER_ID, botId: BOT_ID, threadId: THREAD_ID, agent: "scout" }, SECRET);
  const actor = db.authenticateActorAssertion(assertion);
  assert.equal(actor.userId, USER_ID);
  assert.equal(actor.botId, BOT_ID);
  assert.equal(actor.threadId, THREAD_ID);
  assert.equal(typeof actor.issuedAt, "number");
});

test("an assertion signed with another secret is refused", () => {
  const db = database();
  const assertion = signActorAssertion(
    { userId: USER_ID, botId: BOT_ID, threadId: THREAD_ID, agent: "scout" },
    "different-relay-tool-actor-secret-over-32-bytes",
  );
  assert.throws(() => db.authenticateActorAssertion(assertion), /signature is invalid/);
});

test("chooseMeetingCapture falls back to the room's readable capture when the exact one is empty", () => {
  const empty = { id: "denied", segment_count: 0, native_id: "hco-afyb-cwn" };
  const readable = { id: "good", segment_count: 691, native_id: "hco-afyb-cwn" };
  // A denied/never-admitted attempt must not mask the room's recording.
  assert.equal(chooseMeetingCapture(empty, { id: "sibling" }), "sibling");
  // With content, the exact capture wins even if a sibling exists.
  assert.equal(chooseMeetingCapture(readable, { id: "sibling" }), "good");
  // No room to fall back to (null native_id), or no sibling: keep the exact row.
  assert.equal(chooseMeetingCapture({ id: "x", segment_count: 0, native_id: null }, { id: "sibling" }), "x");
  assert.equal(chooseMeetingCapture(empty, null), "denied");
});

test("nativeIdFromMeetingRef extracts the provider code from a URL or a bare code", () => {
  // Meet: first path segment.
  assert.equal(nativeIdFromMeetingRef("https://meet.google.com/abc-defg-hij?pli=1#frag"), "abc-defg-hij");
  // Zoom: the id after /j, /wc, or /s.
  assert.equal(nativeIdFromMeetingRef("https://us02web.zoom.us/j/1234567890?pwd=x"), "1234567890");
  assert.equal(nativeIdFromMeetingRef("https://us02web.zoom.us/wc/1234567890"), "1234567890");
  // Teams: the id after /meet (a /meetup-join link has no native id — null,
  // matching the worker, so it can never match a stored row).
  assert.equal(nativeIdFromMeetingRef("https://teams.live.com/meet/9385623070170"), "9385623070170");
  assert.equal(nativeIdFromMeetingRef("https://teams.microsoft.com/l/meetup-join/19%3Aabc%40thread"), null);
  // Bare room code: passed through unchanged.
  assert.equal(nativeIdFromMeetingRef("  abc-defg-hij  "), "abc-defg-hij");
  // Unparseable / empty: null.
  assert.equal(nativeIdFromMeetingRef("not a url"), "not a url");
  assert.equal(nativeIdFromMeetingRef(""), null);
});
