/** Manual join identity + authorization: idempotency keys, capture instances,
// active-session rule, Mercury/workspace scope, actor verification. DB-backed
// tests isolate into a temp RELAY_DATA_DIR per test (never the real fleet). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signedActorContext, verifyActorAssertion } from "./relay-mcp.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const MERCURY = "22222222-2222-4222-8222-222222222222";
const SCOUT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const SECRET = "test-actor-secret-that-is-long-enough-32b";
const MEET = "https://meet.google.com/abc-defg-hij";
const MEET_OTHER = "https://meet.google.com/xyz-uvwx-yz1";

let dirs: string[] = [];
let dbmod: typeof import("./message-db.ts");
let intents: typeof import("./scribe-intents.ts");

beforeEach(async () => {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "scribe-intent-test-"));
  dirs.push(dir);
  process.env.RELAY_DATA_DIR = dir;
  dbmod = await import("./message-db.ts");
  intents = await import("./scribe-intents.ts");
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DATA_DIR;
});

function accept(over: Partial<Parameters<typeof intents.acceptManualJoin>[0]> = {}) {
  return intents.acceptManualJoin({
    requestKey: "req-1",
    meetingUrl: MEET,
    platform: "google_meet",
    actor: { userId: USER, botId: MERCURY, threadId: THREAD },
    now: 1_000,
    ...over,
  });
}

describe("normalizeMeetingUrlKey", () => {
  it("keys platform, lowercase host, and path while dropping query and fragment", () => {
    expect(intents.normalizeMeetingUrlKey("google_meet", "https://meet.google.com/abc-defg-hij?pli=1#frag"))
      .toBe("google_meet|meet.google.com/abc-defg-hij");
  });

  it("rejects non-https, credentials, and platform mismatches", () => {
    expect(intents.normalizeMeetingUrlKey("google_meet", "http://meet.google.com/abc")).toBeNull();
    expect(intents.normalizeMeetingUrlKey("google_meet", "https://meet.google.com@127.0.0.1/")).toBeNull();
    expect(intents.normalizeMeetingUrlKey("zoom", MEET)).toBeNull();
    expect(intents.normalizeMeetingUrlKey("google_meet", "not a url")).toBeNull();
  });
});

describe("acceptManualJoin idempotency", () => {
  it("creates once: same request key returns the original instance", () => {
    const first = accept();
    expect(first.outcome).toBe("created");
    const second = accept();
    expect(second.outcome).toBe("duplicate");
    expect(second.intent.instanceId).toBe(first.intent.instanceId);
    expect(dbmod.listPendingScribeJoinIntents()).toHaveLength(1);
  });

  it("collapses a different request for the same live room onto the active instance", () => {
    const first = accept();
    const second = accept({ requestKey: "req-2" });
    expect(second.outcome).toBe("active");
    expect(second.intent.instanceId).toBe(first.intent.instanceId);
    expect(dbmod.listPendingScribeJoinIntents()).toHaveLength(1);
  });

  it("allows a new capture of the same room after the first terminates", () => {
    const first = accept();
    expect(dbmod.setScribeJoinIntentStatus(first.intent.instanceId, "terminal", 2_000)).toBe(true);
    const second = accept({ requestKey: "req-2", now: 3_000 });
    expect(second.outcome).toBe("created");
    expect(second.intent.instanceId).not.toBe(first.intent.instanceId);
  });

  it("treats armed intents as active too", () => {
    const first = accept();
    expect(dbmod.setScribeJoinIntentStatus(first.intent.instanceId, "armed", 2_000)).toBe(true);
    const second = accept({ requestKey: "req-2", now: 3_000 });
    expect(second.outcome).toBe("active");
  });

  it("serializes concurrent submissions of the same request key", async () => {
    const input = {
      requestKey: "req-race",
      meetingUrl: MEET,
      platform: "google_meet" as const,
      actor: { userId: USER, botId: MERCURY, threadId: THREAD },
      now: 1_000,
    };
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => intents.acceptManualJoin(input)),
      Promise.resolve().then(() => intents.acceptManualJoin(input)),
    ]);
    // Exactly one winner creates; the loser reads the winner's row. The
    // single SQLite transaction makes the interleaving irrelevant.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["created", "duplicate"]);
    expect(a.intent.instanceId).toBe(b.intent.instanceId);
    expect(dbmod.listPendingScribeJoinIntents()).toHaveLength(1);
  });

  it("lists pending and armed intents for the drain, pending first", () => {
    const first = accept({ requestKey: "req-a", meetingUrl: MEET });
    const second = accept({ requestKey: "req-b", meetingUrl: MEET_OTHER });
    expect(dbmod.setScribeJoinIntentStatus(first.intent.instanceId, "armed", 2_000)).toBe(true);
    expect(dbmod.setScribeJoinIntentStatus(second.intent.instanceId, "terminal", 2_000)).toBe(true);
    const third = accept({ requestKey: "req-c", meetingUrl: "https://meet.google.com/third-room-xyz" });
    const active = dbmod.listActiveScribeJoinIntents();
    expect(active.map((i) => i.instanceId)).toEqual([third.intent.instanceId, first.intent.instanceId]);
  });

  it("survives a restart: pending intents and idempotency persist", async () => {
    const first = accept();
    expect(first.outcome).toBe("created");
    // Simulate a process restart: fresh module state, same data directory.
    vi.resetModules();
    const db2 = await import("./message-db.ts");
    const intents2 = await import("./scribe-intents.ts");
    expect(db2.listPendingScribeJoinIntents()).toHaveLength(1);
    expect(db2.listPendingScribeJoinIntents()[0]!.instanceId).toBe(first.intent.instanceId);
    const retry = intents2.acceptManualJoin({
      requestKey: "req-1",
      meetingUrl: MEET,
      platform: "google_meet",
      actor: { userId: USER, botId: MERCURY, threadId: THREAD },
      now: 9_999,
    });
    expect(retry.outcome).toBe("duplicate");
    expect(retry.intent.instanceId).toBe(first.intent.instanceId);
  });

  it("creates independent instances for different rooms", () => {
    const first = accept();
    const second = accept({ requestKey: "req-2", meetingUrl: MEET_OTHER });
    expect(second.outcome).toBe("created");
    expect(second.intent.instanceId).not.toBe(first.intent.instanceId);
  });

  it("rejects malformed input without writing", () => {
    expect(() => accept({ meetingUrl: "https://evil.example/x" })).toThrow("invalid meeting URL");
    expect(dbmod.listPendingScribeJoinIntents()).toHaveLength(0);
  });
});

describe("authorizeScribeJoiner", () => {
  const storeFor = (bot: { relayAgent?: string; ownerUserId?: string } | null) => ({
    bot: (_id: string) => bot as never,
  });

  it("allows Mercury owned by the actor", () => {
    expect(intents.authorizeScribeJoiner(
      { userId: USER, botId: MERCURY, threadId: THREAD },
      storeFor({ relayAgent: "mercury", ownerUserId: USER }),
    )).toEqual({ ok: true });
  });

  it("denies unknown bots, non-Mercury roles, and cross-workspace actors", () => {
    const actor = { userId: USER, botId: MERCURY, threadId: THREAD };
    expect(intents.authorizeScribeJoiner(actor, storeFor(null))).toEqual({ ok: false, reason: "unknown bot" });
    expect(intents.authorizeScribeJoiner(actor, storeFor({ relayAgent: "scout", ownerUserId: USER })))
      .toEqual({ ok: false, reason: "scribe join requires Mercury" });
    expect(intents.authorizeScribeJoiner(
      { userId: OTHER_USER, botId: MERCURY, threadId: THREAD },
      storeFor({ relayAgent: "mercury", ownerUserId: USER }),
    )).toEqual({ ok: false, reason: "bot is not owned by the actor" });
    expect(intents.authorizeScribeJoiner(
      { userId: USER, botId: SCOUT, threadId: THREAD },
      storeFor({ relayAgent: undefined, ownerUserId: USER }),
    )).toEqual({ ok: false, reason: "scribe join requires Mercury" });
  });
});

describe("verifyActorAssertion (harness)", () => {
  it("round-trips a harness-signed assertion", () => {
    const assertion = signedActorContext({ userId: USER, botId: MERCURY, threadId: THREAD }, SECRET);
    expect(verifyActorAssertion(assertion, SECRET)).toEqual({ userId: USER, botId: MERCURY, threadId: THREAD });
  });

  it("rejects tampered, expired, wrong-secret, and malformed assertions", () => {
    const good = signedActorContext({ userId: USER, botId: MERCURY, threadId: THREAD }, SECRET);
    const tampered = JSON.stringify({ ...JSON.parse(good), threadId: THREAD.slice(0, -1) + "0" });
    expect(() => verifyActorAssertion(tampered, SECRET)).toThrow("signature is invalid");
    const old = signedActorContext(
      { userId: USER, botId: MERCURY, threadId: THREAD }, SECRET,
      Math.floor(Date.now() / 1000) - 601,
    );
    expect(() => verifyActorAssertion(old, SECRET)).toThrow("expired or outside allowed clock skew");
    expect(() => verifyActorAssertion(good, "a-different-secret-that-is-long-enough")).toThrow("signature is invalid");
    expect(() => verifyActorAssertion(good, "short")).toThrow("not configured");
    expect(() => verifyActorAssertion("not-json", SECRET)).toThrow("invalid");
    expect(() => verifyActorAssertion(undefined, SECRET)).toThrow("invalid");
  });
});

describe("resolveNoticeSender", () => {
  const relay = { userId: USER, botId: MERCURY, threadId: THREAD };
  const intentRow = {
    requestKey: "req-1",
    instanceId: "inst-1",
    source: "manual",
    meetingUrl: MEET,
    urlKey: "google_meet|meet.google.com/abc-defg-hij",
    platform: "google_meet",
    title: null,
    organizerEmail: null,
    ownerUserId: OTHER_USER,
    botId: SCOUT,
    threadId: THREAD,
    status: "armed" as const,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  it("prefers the persisted intent triple over the relay actor", () => {
    expect(intents.resolveNoticeSender(intentRow, relay)).toEqual({
      userId: OTHER_USER,
      botId: SCOUT,
      threadId: THREAD,
    });
  });

  it("falls back to the relay actor without an intent, undefined last", () => {
    expect(intents.resolveNoticeSender(null, relay)).toEqual(relay);
    expect(intents.resolveNoticeSender(null, undefined)).toBeUndefined();
  });
});

describe("joinRequestFromIntent", () => {
  it("builds an immediately-due request with a manual receipt namespace", () => {
    const { intent } = accept({ title: "Investor sync" });
    const request = intents.joinRequestFromIntent(intent, { manualLateMs: 300_000, reconcileGraceMs: 1_800_000 });
    expect(request.source).toBe("manual");
    expect(request.descriptor).toMatchObject({
      instance_id: intent.instanceId,
      platform: "google_meet",
      meeting_url: MEET,
      title: "Investor sync",
    });
    expect(request.dueAtMs).toBe(intent.createdAt);
    expect(request.lateAtMs).toBe(intent.createdAt + 300_000);
    expect(request.receiptKey).toBe(`manual|${intent.instanceId}`);
    expect(request.event).toMatchObject({ id: intent.instanceId, summary: "Investor sync" });
  });
});
