import assert from "node:assert/strict";
import { test } from "node:test";

import { TakeoverSessionManager, takeoverBusyMessage } from "./takeover-session.js";
import { ViewerTokens } from "./takeover-viewer.js";

const USER_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER_B = "9c858901-8a57-4791-81fe-4c455b099bc9";
const USER_C = "1b2c3d4e-5f60-4a70-9b80-c2d3e4f5a60b";
const BOT = "11111111-1111-4111-8111-111111111111";
const BOT_B = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const THREAD_B = "44444444-4444-4444-8444-444444444444";
const TURN = "turn-a";
const TURN_B = "turn-b";

const actor = (userId = USER_A, botId = BOT, threadId = THREAD, turnId = TURN) => ({ userId, botId, threadId, turnId });

test("acquire creates a headless session and reuses it for the same turn", () => {
  const m = new TakeoverSessionManager();
  const first = m.acquire(actor(), "headless");
  assert.equal(first.created, true);
  assert.equal(first.session.state, "agent_headless");
  const second = m.acquire(actor(), "headless");
  assert.equal(second.created, false);
  assert.equal(second.session.id, first.session.id);
});

test("a different turn on the same thread is busy", () => {
  const m = new TakeoverSessionManager();
  m.acquire(actor(), "headless");
  assert.throws(() => m.acquire(actor(USER_A, BOT, THREAD, TURN_B)), /still in use by another task/);
  assert.throws(() => m.acquire(actor(USER_A, BOT_B, THREAD)), /still in use/);
});

test("upgradeHeadful changes the lane and bumps the generation", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.acquire(actor(), "headless");
  const before = session.generation;
  assert.equal(m.upgradeHeadful(session.id, before), true);
  const upgraded = m.get(session.id)!;
  assert.equal(upgraded.state, "agent_headful");
  assert.equal(upgraded.generation, before + 1);
  assert.throws(() => m.handBack(session.id, before), /stale/);
});

test("hand back returns to headful when a display exists, headless otherwise", () => {
  const m = new TakeoverSessionManager();
  const a = m.requestHuman(actor(), ":99");
  m.handBack(a.session.id, a.session.generation);
  assert.equal(m.get(a.session.id)?.state, "agent_headful");
  assert.equal(m.get(a.session.id)?.display, ":99");

  const b = m.requestHuman(actor(USER_B));
  m.handBack(b.session.id, b.session.generation);
  assert.equal(m.get(b.session.id)?.state, "agent_headless");
});

test("agentSession is bound to user, bot, thread and turn", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.acquire(actor(), "headless");
  assert.equal(m.agentSession(actor())?.id, session.id);
  assert.equal(m.agentSession(actor(USER_A, BOT_B, THREAD)), null);
  assert.equal(m.agentSession(actor(USER_A, BOT, THREAD_B)), null);
  assert.equal(m.agentSession(actor(USER_A, BOT, THREAD, TURN_B)), null);
  assert.equal(m.agentSession(actor(USER_B)), null);
});

test("hand-back lets the resumed turn adopt the same browser", () => {
  const m = new TakeoverSessionManager();
  const first = m.requestHuman(actor(USER_A, BOT, THREAD, TURN), ":99");
  m.handBack(first.session.id, first.session.generation);
  const resumed = m.acquire(actor(USER_A, BOT, THREAD, TURN_B), "headful");
  assert.equal(resumed.created, false);
  assert.equal(resumed.session.id, first.session.id);
  assert.equal(resumed.session.turnId, TURN_B);
  assert.throws(() => m.acquire(actor(USER_A, BOT_B, THREAD, TURN), "headless"), /still in use/);
});

test("the resumed turn claims the handed-back session and the old turn cannot close it", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor(USER_A, BOT, THREAD, TURN), ":99");
  m.handBack(session.id, session.generation);
  m.claimTurn(session.id, TURN_B);
  assert.equal(m.get(session.id)?.turnId, TURN_B);
  assert.equal(m.closeTurn(actor(USER_A, BOT, THREAD, TURN)), false);
  assert.equal(m.get(session.id)?.id, session.id);
  assert.equal(m.closeTurn(actor(USER_A, BOT, THREAD, TURN_B)), true);
});

test("turn-end close leaves a pending human takeover alone", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor(), ":99");
  assert.equal(m.closeTurn(actor()), false);
  assert.equal(m.get(session.id)?.state, "user_takeover");
});

test("a delayed close for an older turn is a harmless no-op", () => {
  const m = new TakeoverSessionManager();
  const old = m.acquire(actor(USER_A, BOT, THREAD, TURN), "headless").session;
  const oldGeneration = old.generation;
  m.closeTurn(actor(USER_A, BOT, THREAD, TURN));
  const current = m.acquire(actor(USER_A, BOT, THREAD, TURN_B), "headless").session;
  assert.equal(m.closeForActor(actor(USER_A, BOT, THREAD, TURN), old.id, oldGeneration), false);
  assert.equal(m.get(current.id)?.id, current.id);
});

test("closeForActor closes only the exact session", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.acquire(actor(), "headless");
  assert.equal(m.closeForActor(actor(), session.id, session.generation + 1), false);
  assert.equal(m.get(session.id)?.id, session.id);
  assert.equal(m.closeForActor(actor(), session.id, session.generation), true);
  assert.equal(m.get(session.id), undefined);
});

test("release is idempotent once the session is gone", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor());
  assert.equal(m.release(session.id, session.generation), true);
  assert.equal(m.release(session.id, session.generation), false);
});

test("idle closes an agent session; touch extends it; busy is skipped", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const m = new TakeoverSessionManager({ idleMs: 100, now: () => now, onEvent: (e) => events.push(e) });
  const { session } = m.acquire(actor(), "headless");
  now += 90;
  m.touchByUser(USER_A);
  now += 90;
  m.sweepExpired();
  assert.equal(m.get(session.id)?.id, session.id, "activity extended the idle clock");
  m.markBusy(session.id, true);
  now += 101;
  m.sweepExpired();
  assert.equal(m.get(session.id)?.id, session.id, "busy sessions are never swept");
  m.markBusy(session.id, false);
  m.sweepExpired();
  assert.equal(m.get(session.id), undefined);
  assert.equal((events.at(-1) as { reason: string }).reason, "idle");
});

test("the hard cap closes even an actively used session", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const m = new TakeoverSessionManager({ idleMs: 100, maxLifetimeMs: 500, now: () => now, onEvent: (e) => events.push(e) });
  const { session } = m.acquire(actor(), "headless");
  for (let i = 0; i < 6; i++) {
    now += 90;
    m.touchByUser(USER_A);
    m.sweepExpired();
  }
  assert.equal(m.get(session.id), undefined);
  assert.equal((events.at(-1) as { reason: string }).reason, "hard-cap");
});

test("an unclaimed sign-in expires after the user-takeover window", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const m = new TakeoverSessionManager({ userTakeoverMs: 100, now: () => now, onEvent: (e) => events.push(e) });
  const { session } = m.requestHuman(actor());
  now += 101;
  m.sweepExpired();
  assert.equal(m.get(session.id), undefined);
  assert.equal((events.at(-1) as { reason: string }).reason, "expired");
});

test("the viewer capacity applies only to human takeovers, not agent sessions", () => {
  const m = new TakeoverSessionManager({ maxConcurrent: 2 });
  m.acquire(actor(USER_A), "headless");
  m.acquire(actor(USER_B), "headless");
  const third = m.acquire(actor(USER_C), "headless");
  assert.equal(third.created, true);
  m.requestHuman(actor(USER_A));
  m.requestHuman(actor(USER_B));
  assert.throws(() => m.requestHuman(actor(USER_C)), /capacity/);
});

test("a held cross-process lease refuses the session and is released on close", () => {
  let held = false;
  let released = false;
  const m = new TakeoverSessionManager({
    leaseFor: () => {
      held = true;
      return { release: () => { released = true; held = false; } };
    },
  });
  const { session } = m.acquire(actor(), "headless");
  assert.equal(held, true);
  m.release(session.id, session.generation);
  assert.equal(released, true);

  const blocked = new TakeoverSessionManager({ leaseFor: () => null });
  assert.throws(() => blocked.acquire(actor(USER_B), "headless"), /still in use by another task/);
});

test("busy copy distinguishes the person from a finishing agent turn", () => {
  assert.match(takeoverBusyMessage("user_takeover"), /person is using the interactive browser/);
  assert.match(takeoverBusyMessage("agent_headless"), /still in use by another task/);
  assert.match(takeoverBusyMessage("agent_headful"), /still in use by another task/);
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
