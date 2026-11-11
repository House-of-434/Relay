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

const actor = (userId = USER_A, botId = BOT, threadId = THREAD) => ({ userId, botId, threadId });

test("one session per user; a competing thread gets busy", () => {
  const m = new TakeoverSessionManager();
  const first = m.requestHuman(actor());
  assert.equal(first.created, true);
  assert.equal(first.session.state, "user_takeover");
  assert.throws(() => m.requestHuman(actor(USER_A, BOT_B, THREAD_B)), /person is using the interactive browser/);
  // The owner keeps control.
  assert.equal(m.ownedSession(USER_A, first.session.id)?.state, "user_takeover");
});

test("busy copy distinguishes the person from a finishing agent turn", () => {
  assert.match(takeoverBusyMessage("user_takeover"), /person is using the interactive browser/);
  assert.match(takeoverBusyMessage("agent_active"), /still in use by another task; it will be released when that task finishes/);
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor());
  m.handBack(session.id, session.generation);
  assert.throws(
    () => m.requestHuman(actor(USER_A, BOT_B, THREAD_B)),
    /still in use by another task/,
  );
});

test("a second user is never blocked by another user's session", () => {
  const m = new TakeoverSessionManager();
  const a = m.requestHuman(actor(USER_A));
  const b = m.requestHuman(actor(USER_B));
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.session.id, b.session.id);
  assert.equal(m.sessionForUser(USER_A)?.id, a.session.id);
  assert.equal(m.sessionForUser(USER_B)?.id, b.session.id);
});

test("the same thread joins the session instead of creating a second", () => {
  const m = new TakeoverSessionManager();
  const first = m.requestHuman(actor());
  const second = m.requestHuman(actor());
  assert.equal(second.created, false);
  assert.equal(second.session.id, first.session.id);
});

test("hand back keeps the session and flips control to the agent", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor(), ":99");
  assert.equal(m.isUserTakeover(USER_A), true);
  assert.equal(m.handBack(session.id, session.generation), true);
  assert.equal(m.isUserTakeover(USER_A), false);
  assert.equal(m.get(session.id)?.state, "agent_active");
  assert.equal(m.get(session.id)?.display, ":99");
  assert.equal(m.handBack(session.id, session.generation), true, "idempotent");
});

test("agentSession is bound to the exact bot and thread", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor());
  m.handBack(session.id, session.generation);
  assert.equal(m.agentSession(actor())?.id, session.id);
  assert.equal(m.agentSession(actor(USER_A, BOT_B, THREAD)), null);
  assert.equal(m.agentSession(actor(USER_A, BOT, THREAD_B)), null);
  assert.equal(m.agentSession(actor(USER_B, BOT, THREAD)), null);
});

test("release is idempotent once the session is gone", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor());
  assert.equal(m.release(session.id, session.generation), true);
  assert.equal(m.release(session.id, session.generation), false);
});

test("stale generation is fenced", () => {
  const m = new TakeoverSessionManager();
  const { session } = m.requestHuman(actor());
  session.generation += 1;
  assert.throws(() => m.release(session.id, 1), /stale/);
  assert.throws(() => m.handBack(session.id, 1), /stale/);
});

test("idle closes an agent-active session; touch extends it", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const m = new TakeoverSessionManager({ idleMs: 100, now: () => now, onEvent: (e) => events.push(e) });
  const { session } = m.requestHuman(actor());
  m.handBack(session.id, session.generation);
  now += 90;
  m.touchByUser(USER_A);
  now += 90;
  m.sweepExpired();
  assert.equal(m.get(session.id)?.state, "agent_active", "activity extended the idle clock");
  now += 101;
  m.sweepExpired();
  assert.equal(m.get(session.id), undefined);
  assert.equal((events.at(-1) as { reason: string }).reason, "idle");
});

test("the hard cap closes even an actively used session", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const m = new TakeoverSessionManager({ idleMs: 100, maxLifetimeMs: 500, now: () => now, onEvent: (e) => events.push(e) });
  const { session } = m.requestHuman(actor());
  m.handBack(session.id, session.generation);
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

test("capacity is two sessions across users", () => {
  const m = new TakeoverSessionManager({ maxConcurrent: 2 });
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
  const { session } = m.requestHuman(actor());
  assert.equal(held, true);
  m.release(session.id, session.generation);
  assert.equal(released, true);

  const blocked = new TakeoverSessionManager({ leaseFor: () => null });
  assert.throws(() => blocked.requestHuman(actor(USER_B)), /still in use by another task/);
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
