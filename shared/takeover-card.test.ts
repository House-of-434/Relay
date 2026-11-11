import { describe, expect, it } from "vitest";

import { takeoverPending } from "./takeover-card.ts";
import type { TakeoverCardData } from "./wire.ts";

const card: TakeoverCardData = {
  kind: "browser_takeover",
  sessionId: "login_1",
  generation: 1,
  title: "Sign in to linkedin.com",
  status: "pending",
  expiresAt: "2026-01-01T00:00:00.000Z",
};

describe("takeover cards", () => {
  it("treats only a pending card as actionable", () => {
    expect(takeoverPending(card)).toBe(true);
    expect(takeoverPending({ ...card, status: "done" })).toBe(false);
  });
});
