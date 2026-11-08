import { describe, expect, it } from "vitest";

import { isPendingTakeoverRequest, takeoverPending, takeoverResumeOutcome } from "./takeover-card.ts";
import type { TakeoverCardData } from "./wire.ts";

const card: TakeoverCardData = {
  kind: "browser_takeover",
  sessionId: "login_1",
  generation: 1,
  title: "Sign in to linkedin.com",
  description: "Sign in",
  status: "pending",
  expiresAt: "2026-01-01T00:00:00.000Z",
  requestKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
};

describe("takeover cards", () => {
  it("treats only a pending card as actionable", () => {
    expect(takeoverPending(card)).toBe(true);
    expect(takeoverPending({ ...card, status: "done" })).toBe(false);
  });

  it("maps terminal states to the shared resume outcomes", () => {
    expect(takeoverResumeOutcome("done")).toBe("provided");
    expect(takeoverResumeOutcome("dismissed")).toBe("dismissed");
    expect(takeoverResumeOutcome("expired")).toBe("dismissed");
    expect(takeoverResumeOutcome("pending")).toBeNull();
  });

  it("matches one pending request key per bot in a room thread", () => {
    const message = { kind: "takeover" as const, takeover: card, from: { botId: "bot-1", name: "Scout", color: "blue" as const } };
    expect(isPendingTakeoverRequest(message, card.requestKey, "bot-1", true)).toBe(true);
    expect(isPendingTakeoverRequest(message, "other", "bot-1", true)).toBe(false);
    expect(isPendingTakeoverRequest(message, card.requestKey, "bot-2", true)).toBe(false);
    expect(isPendingTakeoverRequest({ ...message, takeover: { ...card, status: "done" } }, card.requestKey, "bot-1", true)).toBe(false);
  });
});
