import { describe, expect, it } from "vitest";

import { ToolLayerTakeoverClient, latestSettledTakeover } from "./browser-takeover.ts";
import type { TakeoverCardData, WireMessage } from "../shared/wire.ts";

type Row = Pick<WireMessage, "id" | "kind" | "takeover">;

const card = (over: Partial<TakeoverCardData> = {}): TakeoverCardData => ({
  kind: "browser_takeover",
  sessionId: "login_1",
  generation: 1,
  title: "Sign in",
  status: "done",
  expiresAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const takeover = (id: string, over: Partial<TakeoverCardData> = {}): Row => ({
  id,
  kind: "takeover",
  takeover: card(over),
});

const text = (id: string): Row => ({ id, kind: "text" });

describe("latestSettledTakeover", () => {
  it("releases only when the latest takeover card is done", () => {
    expect(latestSettledTakeover([takeover("m1")])?.messageId).toBe("m1");
    expect(latestSettledTakeover([takeover("m1"), text("m2")])?.messageId).toBe("m1");
  });

  it("does not release a pending, dismissed, or expired card", () => {
    for (const status of ["pending", "dismissed", "expired"] as const) {
      expect(latestSettledTakeover([takeover("m1", { status })])).toBeNull();
      expect(latestSettledTakeover([takeover("m0"), takeover("m1", { status })])).toBeNull();
    }
  });

  it("keeps a newer pending takeover alive over an older done card", () => {
    expect(latestSettledTakeover([
      takeover("m1", { sessionId: "login_old" }),
      takeover("m2", { sessionId: "login_new", status: "pending" }),
    ])).toBeNull();
  });

  it("returns nothing for a thread without takeover cards", () => {
    expect(latestSettledTakeover([])).toBeNull();
    expect(latestSettledTakeover([text("m1")])).toBeNull();
  });
});

describe("ToolLayerTakeoverClient.release", () => {
  it("reports whether the tool layer actually closed a session", async () => {
    let released = false;
    const client = new ToolLayerTakeoverClient({
      toolUrl: "http://tools.test",
      actorSecret: "test-actor-secret-that-is-long-enough-32b",
      fetcher: async () => new Response(JSON.stringify({ released }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const actor = {
      userId: "11111111-1111-4111-8111-111111111111",
      botId: "22222222-2222-4222-8222-222222222222",
      threadId: "33333333-3333-4333-8333-333333333333",
      agent: "scout" as const,
    };
    expect(await client.release(actor, "login_1", 1)).toBe(false);
    released = true;
    expect(await client.release(actor, "login_1", 1)).toBe(true);
  });
});
