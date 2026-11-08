import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { TakeoverCard } from "./TakeoverCard";

function message(over: Partial<NonNullable<Message["takeover"]>> = {}, text?: string): Message {
  return {
    id: "m1",
    role: "bot",
    kind: "takeover",
    at: 0,
    ...(text ? { text } : {}),
    takeover: {
      kind: "browser_takeover",
      sessionId: "login_1",
      generation: 1,
      title: "x.com",
      description: "Finish the signup",
      status: "pending",
      expiresAt: "2026-01-01T00:00:00.000Z",
      requestKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      ...over,
    },
  };
}

const render = (m: Message) => renderToStaticMarkup(createElement(TakeoverCard, { botId: "b1", threadId: "t1", message: m }));

describe("takeover card", () => {
  it("is one click target with no actions of its own", () => {
    const html = render(message());
    expect(html).toContain("x.com");
    expect(html).toContain("Finish the signup");
    expect(html).toContain("Open live browser");
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("Hand back to bot");
    expect(html).not.toContain(">Dismiss<");
    // The whole card is the button; the open hint is not a nested control.
    expect(html.match(/<button/g)?.length).toBe(1);
  });

  it("collapses to a status row after a completed hand-back", () => {
    const html = render(message({ status: "done", resumed: true }));
    expect(html).toContain("Handed back — the bot is continuing on this page.");
    expect(html).toContain("Bot resumed on this page.");
    expect(html).not.toContain("Open live browser");
    expect(html).not.toContain("Retry");
  });

  it("offers Retry only when the continuation actually failed", () => {
    const failed = render(message({ status: "done", resumed: false, error: "turn admission blocked" }));
    expect(failed).toContain("Retry");
    expect(failed).toContain("turn admission blocked");

    const dismissed = render(message({ status: "dismissed", resumed: true }));
    expect(dismissed).toContain("Dismissed");
    expect(dismissed).not.toContain("Retry");
  });
});
