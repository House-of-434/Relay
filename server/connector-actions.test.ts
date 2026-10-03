import { describe, expect, it } from "vitest";

import {
  CONNECTOR_ACTION_TTL_MS,
  ConnectorActionError,
  connectorActionDisplay,
  PendingConnectorActions,
} from "./connector-actions.ts";

const BOT = "bot-mercury";
const THREAD = "thread-1";
const INVITE = {
  summary: "Project Review",
  start: { dateTime: "2026-10-06T10:00:00-04:00" },
  end: { dateTime: "2026-10-06T10:30:00-04:00" },
  when: "Tuesday, October 6 at 10:00 AM",
  attendees: ["alex@example.test", "jordan@example.test", "priya@example.test"],
};
const SEND = {
  to: ["alex@example.test", "jordan@example.test"],
  subject: "Follow-up",
  body: "Thanks for the conversation today.",
};

describe("connector actions", () => {
  it("validates strictly and rejects unknown fields", () => {
    const pending = new PendingConnectorActions();
    expect(() => pending.submit({
      kind: "calendar-invite", target: { ...INVITE, calendarId: "other" }, botId: BOT, threadId: THREAD,
    })).toThrowError(ConnectorActionError);
    expect(() => pending.submit({
      kind: "gmail-send", target: { ...SEND, to: ["not-an-address"] }, botId: BOT, threadId: THREAD,
    })).toThrowError(ConnectorActionError);
    expect(() => pending.submit({
      kind: "gmail-send", target: { to: [], subject: "", body: "x" }, botId: BOT, threadId: THREAD,
    })).toThrowError(ConnectorActionError);
  });

  it("names the attendee count and every attendee on an invite preview", () => {
    const display = connectorActionDisplay("calendar-invite", INVITE);
    expect(display.title).toBe("Confirm event and invitations");
    expect(display.subtitle).toContain("Project Review");
    expect(display.detail).toContain("creates this on your primary calendar");
    expect(display.detail).toContain("Attendees (3): alex@example.test, jordan@example.test, priya@example.test");
    expect(display.detail).toContain("Google emails invitations to all these attendees");
  });

  it("shows recipients, subject, and full body on an email preview", () => {
    const display = connectorActionDisplay("gmail-send", SEND);
    expect(display.title).toBe("Confirm email");
    expect(display.subtitle).toContain("To: alex@example.test, jordan@example.test");
    expect(display.detail).toContain("Subject: Follow-up");
    expect(display.detail).toContain("Thanks for the conversation today.");
    expect(display.detail).toContain("sent to 2 recipients");
  });

  it("truncates a long body for display but keeps it for execution", () => {
    const pending = new PendingConnectorActions();
    const action = pending.submit({
      kind: "gmail-send",
      target: { to: ["a@example.test"], subject: "s", body: "x".repeat(5000) },
      botId: BOT,
      threadId: THREAD,
    });
    const display = connectorActionDisplay(action.kind, action.target);
    expect(display.detail.length).toBeLessThan(5000);
    expect(display.detail).toContain("truncated for display");
    expect((action.target as { body: string }).body).toHaveLength(5000);
  });

  it("consumes exactly once: miss, expiry, and replay are nothing", () => {
    let now = 1_000_000;
    const pending = new PendingConnectorActions(() => now);
    const action = pending.submit({ kind: "calendar-invite", target: INVITE, botId: BOT, threadId: THREAD });

    expect(pending.take("no-such-request")).toBeUndefined();
    expect(pending.take(action.requestId)?.target).toEqual(INVITE);
    expect(pending.take(action.requestId)).toBeUndefined();

    const second = pending.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: THREAD });
    now += CONNECTOR_ACTION_TTL_MS + 1;
    expect(pending.take(second.requestId)).toBeUndefined();
    expect(pending.peek(second.requestId)).toBeUndefined();
  });

  it("bounds pending actions per conversation", () => {
    const pending = new PendingConnectorActions();
    for (let index = 0; index < 10; index += 1) {
      pending.submit({ kind: "gmail-send", target: { ...SEND, subject: `s${index}` }, botId: BOT, threadId: THREAD });
    }
    expect(() => pending.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: THREAD }))
      .toThrowError(ConnectorActionError);
    // Other conversations are unaffected by one thread's backlog.
    expect(pending.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: "thread-2" }).requestId)
      .toBeTypeOf("string");
  });

  it("renders cc plainly and bcc as explicitly hidden", () => {
    const pending = new PendingConnectorActions();
    const action = pending.submit({
      kind: "gmail-send",
      target: {
        to: ["friend@example.test"],
        cc: ["teammate@example.test"],
        bcc: ["observer@example.test"],
        subject: "Launch",
        body: "Shipping Friday.",
      },
      botId: BOT,
      threadId: THREAD,
    });
    const display = connectorActionDisplay(action.kind, action.target);
    expect(display.subtitle).toContain("To: friend@example.test");
    expect(display.subtitle).toContain("Cc: teammate@example.test");
    expect(display.subtitle).toContain("Bcc (hidden from other recipients): observer@example.test");
    expect(display.detail).toContain("sent to 3 recipients");
  });

  it("omits cc and bcc lines when nobody is copied", () => {
    const display = connectorActionDisplay("gmail-send", SEND);
    expect(display.subtitle).not.toContain("Cc:");
    expect(display.subtitle).not.toContain("Bcc");
    expect(display.detail).toContain("sent to 2 recipients");
  });
});

describe("a consumed confirmation", () => {
  it("reports its outcome again instead of looking like a stranger's request", () => {
    // A second tap must never fall through to the generic card resolver, which
    // reports the action as never run and renders as a refusal.
    const actions = new PendingConnectorActions();
    const submitted = actions.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: THREAD });
    expect(actions.settledOutcome(submitted.requestId)).toBeUndefined();

    expect(actions.take(submitted.requestId)).toBeDefined();
    expect(actions.peek(submitted.requestId)).toBeUndefined();
    actions.settle(submitted.requestId, "sent");

    expect(actions.settledOutcome(submitted.requestId)).toBe("sent");
  });

  it("keeps the outcome long enough for a slow repeat, then forgets it", () => {
    let clock = 1_000_000;
    const actions = new PendingConnectorActions(() => clock);
    const submitted = actions.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: THREAD });
    actions.take(submitted.requestId);
    actions.settle(submitted.requestId, "declined");

    clock += CONNECTOR_ACTION_TTL_MS + 1_000;
    expect(actions.settledOutcome(submitted.requestId)).toBe("declined");
    clock += CONNECTOR_ACTION_TTL_MS + 1_000;
    expect(actions.settledOutcome(submitted.requestId)).toBeUndefined();
  });

  it("does not confuse one request's outcome with another's", () => {
    const actions = new PendingConnectorActions();
    const first = actions.submit({ kind: "gmail-send", target: SEND, botId: BOT, threadId: THREAD });
    const second = actions.submit({ kind: "calendar-invite", target: INVITE, botId: BOT, threadId: THREAD });
    actions.take(first.requestId);
    actions.settle(first.requestId, "sent");

    expect(actions.settledOutcome(second.requestId)).toBeUndefined();
    expect(actions.settledOutcome("never-existed")).toBeUndefined();
  });
});
