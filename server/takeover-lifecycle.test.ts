import { afterEach, describe, expect, it, vi } from "vitest";

import { TAKEOVER_RELEASE_RETRY_MS, TakeoverLifecycle, type TakeoverCardRecord } from "./takeover-lifecycle.ts";
import type { TakeoverCardData } from "../shared/wire.ts";

const pendingCard = (over: Partial<TakeoverCardData> = {}): TakeoverCardData => ({
  kind: "browser_takeover",
  sessionId: "session-1",
  generation: 1,
  title: "x.com",
  status: "pending",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...over,
});

function harness(options: {
  card?: TakeoverCardData;
  release?: () => Promise<boolean>;
  handBack?: () => Promise<{ handedBack: boolean }>;
  pending?: TakeoverCardRecord[];
  settled?: TakeoverCardRecord | null;
  queued?: boolean;
}) {
  let card = options.card ?? pendingCard();
  const calls = {
    resume: [] as Array<{ botId: string; threadId: string; messageId: string; note?: string }>,
    marked: [] as string[],
    consumed: [] as string[],
    release: 0,
    handBack: 0,
  };
  const cardRecord = (): TakeoverCardRecord => ({ messageId: "m1", botId: "bot-1", card });
  const lifecycle = new TakeoverLifecycle({
    getCard: () => card,
    patchCard: (_threadId, _messageId, next) => {
      card = next;
    },
    pendingCards: () => options.pending ?? [cardRecord()],
    latestSettled: () => (options.settled === undefined ? cardRecord() : options.settled),
    actorFor: () => ({
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      agent: "scout",
    }),
    client: {
      release: async () => {
        calls.release += 1;
        return options.release ? options.release() : true;
      },
      handBack: async () => {
        calls.handBack += 1;
        return options.handBack ? options.handBack() : { handedBack: true };
      },
    },
    resume: (botId, threadId, messageId, note) => {
      calls.resume.push({ botId, threadId, messageId, ...(note ? { note } : {}) });
      card = { ...card, resumed: true };
    },
    markResumeInFlight: (_threadId, messageId) => calls.marked.push(messageId),
    isResumeQueued: () => options.queued === true,
    consumeResumeInFlight: (_threadId, messageId) => {
      calls.consumed.push(messageId);
      return true;
    },
    logger: { info: () => {}, warn: () => {} },
  });
  return { lifecycle, calls, card: () => card };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("takeover lifecycle", () => {
  it("resumes only after Done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const done = harness({});
    const result = await done.lifecycle.terminal("bot-1", "thread-1", "m1", "done", "finished");
    expect(result).toMatchObject({ status: "done", resumed: true, changed: true });
    expect(done.calls.handBack).toBe(1);
    expect(done.calls.release).toBe(0);
    expect(done.calls.resume).toEqual([
      { botId: "bot-1", threadId: "thread-1", messageId: "m1", note: "finished" },
    ]);
    expect(done.calls.marked).toEqual(["m1"]);

    const dismissed = harness({});
    const settled = await dismissed.lifecycle.terminal("bot-1", "thread-1", "m1", "dismissed");
    expect(settled).toMatchObject({ status: "dismissed", resumed: false, changed: true });
    expect(dismissed.calls.resume).toEqual([]);

    const expired = harness({});
    const gone = await expired.lifecycle.terminal("bot-1", "thread-1", "m1", "expired");
    expect(gone).toMatchObject({ status: "expired", resumed: false, changed: true });
    expect(expired.calls.resume).toEqual([]);
  });

  it("retries a failed release with bounded backoff, then settles expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const run = harness({ release: async () => { throw new Error("tool layer down"); } });

    await run.lifecycle.terminal("bot-1", "thread-1", "m1", "expired").catch(() => {});
    expect(run.calls.release).toBe(1);
    expect(run.card().status).toBe("pending");

    for (const delay of TAKEOVER_RELEASE_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(run.calls.release).toBe(1 + TAKEOVER_RELEASE_RETRY_MS.length);
    expect(run.card().status).toBe("expired");
    expect(run.card().resumed).toBe(false);
  });

  it("never mutates expiresAt while retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const run = harness({ release: async () => { throw new Error("down"); } });
    const expiresAt = run.card().expiresAt;
    await run.lifecycle.terminal("bot-1", "thread-1", "m1", "expired").catch(() => {});
    await vi.advanceTimersByTimeAsync(TAKEOVER_RELEASE_RETRY_MS[0]!);
    expect(run.card().expiresAt).toBe(expiresAt);
  });

  it("supersedes older cards for the same bot and leaves the kept card alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const older = { messageId: "m0", botId: "bot-1", card: pendingCard({ sessionId: "old" }) };
    const otherBot = { messageId: "m2", botId: "bot-2", card: pendingCard({ sessionId: "other" }) };
    const run = harness({ pending: [older, otherBot] });
    run.lifecycle.supersede("bot-1", "thread-1", "m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(run.calls.release).toBe(1);
  });

  it("skips release while a continuation is queued and consumes the in-flight marker", () => {
    const queued = harness({ queued: true, settled: { messageId: "m1", botId: "bot-1", card: pendingCard({ status: "done" }) } });
    queued.lifecycle.releaseSettled("bot-1", "thread-1");
    expect(queued.calls.release).toBe(0);
    expect(queued.calls.consumed).toEqual([]);

    const admitted = harness({ settled: { messageId: "m1", botId: "bot-1", card: pendingCard({ status: "done" }) } });
    admitted.lifecycle.releaseSettled("bot-1", "thread-1");
    expect(admitted.calls.consumed).toEqual(["m1"]);
    expect(admitted.calls.release).toBe(1);
  });

  it("clears the preview when the card settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const run = harness({});
    run.lifecycle.rememberScreenshot("m1", "data:image/png;base64,AAAA", "session-1", 1);
    expect(run.lifecycle.screenshot("m1")).toBe("data:image/png;base64,AAAA");
    await run.lifecycle.terminal("bot-1", "thread-1", "m1", "dismissed");
    expect(run.lifecycle.screenshot("m1")).toBeNull();
  });
});
