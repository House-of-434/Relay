import assert from "node:assert/strict";
import { test } from "node:test";

import { fanOutResume, LoginSessionManager } from "./login-session.js";
import { ViewerTokens } from "./login-viewer.js";

const USER_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER_B = "9c858901-8a57-4791-81fe-4c455b099bc9";
const USER_C = "1b2c3d4e-5f60-4a70-9b80-c2d3e4f5a60b";

test("exclusive ownership: second acquire joins waiters, no second session", () => {
  const events: unknown[] = [];
  const m = new LoginSessionManager({ onEvent: (e) => events.push(e) });
  const a = m.acquire(USER_A, "task-1");
  const b = m.acquire(USER_A, "task-2");
  assert.equal(a.id, b.id);
  assert.deepEqual([...a.waiters].sort(), ["task-1", "task-2"]);
});

test("takeover pauses agent ops server-side until release", () => {
  const m = new LoginSessionManager();
  const s = m.acquire(USER_A, "task-1");
  m.requestHuman(USER_A, "task-1");
  assert.equal(m.isUserTakeover(USER_A), true);
  m.release(s.id, s.generation);
  assert.equal(m.isUserTakeover(USER_A), false);
});

test("release publishes fan-out event per authorized waiter", () => {
  const events: unknown[] = [];
  const m = new LoginSessionManager({ onEvent: (e) => events.push(e) });
  const s = m.requestHuman(USER_A, "task-1");
  m.acquire(USER_A, "task-2");
  m.release(s.id, s.generation);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as { taskIds: string[] }).taskIds.sort(), ["task-1", "task-2"]);
});

test("stale generation is fenced", () => {
  const m = new LoginSessionManager();
  const s = m.acquire(USER_A, "task-1");
  m.bumpGeneration(s.id);
  assert.throws(() => m.release(s.id, 1), /stale/);
});

test("cap of 2 rejects the third concurrent session", () => {
  const m = new LoginSessionManager({ maxConcurrent: 2 });
  m.acquire(USER_A, "t1");
  m.acquire(USER_B, "t2");
  assert.throws(() => m.acquire(USER_C, "t3"), /busy/);
});

test("expire reports blocked status to waiters", () => {
  const events: unknown[] = [];
  const m = new LoginSessionManager({ onEvent: (e) => events.push(e) });
  const s = m.acquire(USER_A, "task-1");
  m.expire(s.id, s.generation);
  assert.deepEqual(events, [
    { kind: "takeover_expired", userId: USER_A, sessionId: s.id, generation: 1, taskIds: ["task-1"] },
  ]);
});

test("viewer tokens are scoped, short-lived, and revocable", () => {
  let now = 1000;
  const v = new ViewerTokens({ ttlMs: 100, now: () => now });
  const t = v.mint("sess-1", USER_A);
  assert.match(t.value, /^[0-9a-f]{32}$/);
  const found = v.find(t.value);
  assert.equal(found?.sessionId, "sess-1");
  assert.equal(found?.userId, USER_A);
  now += 101; // expired
  assert.equal(v.find(t.value), undefined);
  const t2 = v.mint("sess-1", USER_A);
  v.revoke(t2.value);
  assert.equal(v.find(t2.value), undefined);
});

test("fan-out isolates failures: one blocked waiter does not stop others", async () => {
  const resumed: string[] = [];
  const outcomes = await fanOutResume(["a", "b", "c"], async (id) => {
    if (id === "b") throw new Error("boom");
    resumed.push(id);
  });
  assert.deepEqual(resumed.sort(), ["a", "c"]);
  assert.equal(outcomes.find((o) => o.taskId === "b")?.ok, false);
});

test("simultaneous requests create exactly one session", () => {
  const m = new LoginSessionManager();
  const results = Array.from({ length: 5 }, (_, i) => m.requestHuman(USER_A, `task-${i}`));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results[0]!.waiters.length, 5);
});
