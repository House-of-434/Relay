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

describe("connector actions", () => {
  it("validates strictly and rejects unknown fields", () => {
    const pending = new PendingConnectorActions();
    expect(() => pending.submit({
      target: { ...INVITE, calendarId: "other" }, botId: BOT, threadId: THREAD,
    })).toThrowError(ConnectorActionError);
    expect(() => pending.submit({
      target: { ...INVITE, attendees: ["not-an-address"] }, botId: BOT, threadId: THREAD,
    })).toThrowError(ConnectorActionError);
    expect(() => pending.submit({
      target: { summary: "", start: INVITE.start, end: INVITE.end, when: INVITE.when, attendees: [] },
      botId: BOT,
      threadId: THREAD,
    })).toThrowError(ConnectorActionError);
  });

  it("names the attendee count and every attendee on an invite preview", () => {
    const display = connectorActionDisplay(INVITE);
    expect(display.title).toBe("Confirm event and invitations");
    expect(display.subtitle).toContain("Project Review");
    expect(display.detail).toContain("creates this on your primary calendar");
    expect(display.detail).toContain("Attendees (3): alex@example.test, jordan@example.test, priya@example.test");
    expect(display.detail).toContain("Google emails invitations to all these attendees");
  });

  it("summarizes a long attendee list instead of printing all of it", () => {
    const attendees = Array.from({ length: 14 }, (_, index) => `person${index}@example.test`);
    const display = connectorActionDisplay({ ...INVITE, attendees });
    expect(display.detail).toContain("and 4 more");
    expect(display.detail).not.toContain("person13@example.test");
  });

  it("consumes exactly once: miss, expiry, and replay are nothing", () => {
    let now = 1_000_000;
    const pending = new PendingConnectorActions(() => now);
    const action = pending.submit({ target: INVITE, botId: BOT, threadId: THREAD });

    expect(pending.take("no-such-request")).toBeUndefined();
    expect(pending.take(action.requestId)?.target).toEqual(INVITE);
    expect(pending.take(action.requestId)).toBeUndefined();

    const second = pending.submit({ target: INVITE, botId: BOT, threadId: THREAD });
    now += CONNECTOR_ACTION_TTL_MS + 1;
    expect(pending.take(second.requestId)).toBeUndefined();
    expect(pending.peek(second.requestId)).toBeUndefined();
  });

  it("bounds pending actions per conversation", () => {
    const pending = new PendingConnectorActions();
    for (let index = 0; index < 10; index += 1) {
      pending.submit({ target: { ...INVITE, summary: `s${index}` }, botId: BOT, threadId: THREAD });
    }
    expect(() => pending.submit({ target: INVITE, botId: BOT, threadId: THREAD }))
      .toThrowError(ConnectorActionError);
    // Other conversations are unaffected by one thread's backlog.
    expect(pending.submit({ target: INVITE, botId: BOT, threadId: "thread-2" }).requestId)
      .toBeTypeOf("string");
  });
});

describe("a consumed confirmation", () => {
  it("reports its outcome again instead of looking like a stranger's request", () => {
    // A second tap must never fall through to the generic card resolver, which
    // reports the action as never run and renders as a refusal.
    const actions = new PendingConnectorActions();
    const submitted = actions.submit({ target: INVITE, botId: BOT, threadId: THREAD });
    expect(actions.settledOutcome(submitted.requestId)).toBeUndefined();

    expect(actions.take(submitted.requestId)).toBeDefined();
    expect(actions.peek(submitted.requestId)).toBeUndefined();
    actions.settle(submitted.requestId, "created");

    expect(actions.settledOutcome(submitted.requestId)).toBe("created");
  });

  it("keeps the outcome long enough for a slow repeat, then forgets it", () => {
    let clock = 1_000_000;
    const actions = new PendingConnectorActions(() => clock);
    const submitted = actions.submit({ target: INVITE, botId: BOT, threadId: THREAD });
    actions.take(submitted.requestId);
    actions.settle(submitted.requestId, "declined");

    clock += CONNECTOR_ACTION_TTL_MS + 1_000;
    expect(actions.settledOutcome(submitted.requestId)).toBe("declined");
    clock += CONNECTOR_ACTION_TTL_MS + 1_000;
    expect(actions.settledOutcome(submitted.requestId)).toBeUndefined();
  });

  it("does not confuse one request's outcome with another's", () => {
    const actions = new PendingConnectorActions();
    const first = actions.submit({ target: INVITE, botId: BOT, threadId: THREAD });
    const second = actions.submit({ target: { ...INVITE, summary: "Coffee" }, botId: BOT, threadId: THREAD });
    actions.take(first.requestId);
    actions.settle(first.requestId, "created");

    expect(actions.settledOutcome(second.requestId)).toBeUndefined();
    expect(actions.settledOutcome("never-existed")).toBeUndefined();
  });
});
