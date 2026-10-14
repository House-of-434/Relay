import { describe, expect, it } from "vitest";

import {
  ScribeMonitor,
  armKey,
  buildDescriptor,
  eventStartMs,
  meetingUrlFor,
  passcodeFor,
  platformForUrl,
  type CalendarEvent,
  type ReceiptStore,
  type ScribeDescriptor,
  type ScribeMonitorConfig,
  type ScribeNotice,
  type ScribeWorkerStatus,
} from "./scribe-monitor.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const THREE_HOURS = 3 * 60 * 60 * 1000;
const cfg: ScribeMonitorConfig = { pollMs: 60_000, windowBackMs: 86_400_000, windowForwardMs: 86_400_000, armLeadMs: 60_000, lateMaxMs: 300_000, manualLateMs: 300_000, maxResults: 250, reconcileGraceMs: 30 * 60_000, adminAlertIntervalMs: THREE_HOURS };
const SELF = "relay@houseof434.com";

function fakeReceipts(): ReceiptStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    has: (kind, key) => keys.has(`${kind}:${key}`),
    record: (kind, key) => { keys.add(`${kind}:${key}`); },
  };
}

function meetingEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "inst-1",
    summary: "Weekly sync",
    status: "confirmed",
    start: { dateTime: new Date(NOW + 30_000).toISOString() },
    end: { dateTime: new Date(NOW + 1_830_000).toISOString() },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "host@houseof434.com" },
    creator: { email: "host@houseof434.com" },
    attendees: [{ email: "host@houseof434.com" }, { email: "guest@example.com" }],
    ...overrides,
  };
}

function monitor(events: CalendarEvent[], receipts = fakeReceipts(), over: Partial<Parameters<typeof buildMonitor>[0]> = {}) {
  return buildMonitor({ events, receipts, ...over });
}

function buildMonitor(input: {
  events: CalendarEvent[];
  receipts: ReceiptStore;
  joinWorker?: (d: ScribeDescriptor) => Promise<{ status: string }>;
  status?: (instanceId: string) => Promise<ScribeWorkerStatus>;
  notify?: (n: ScribeNotice) => void;
  now?: number;
  logs?: string[];
}) {
  const joins: ScribeDescriptor[] = [];
  const notified: ScribeNotice[] = [];
  const logs = input.logs ?? [];
  const m = new ScribeMonitor(
    {
      listEvents: async () => input.events,
      joinWorker: input.joinWorker ?? (async (d) => { joins.push(d); return { status: "joining" }; }),
      status: input.status ?? (async () => ({ status: "unknown" })),
      receipts: input.receipts,
      notify: (n) => { notified.push(n); input.notify?.(n); },
      selfAddress: SELF,
      now: () => input.now ?? NOW,
      log: (msg) => logs.push(msg),
    },
    cfg,
  );
  return { m, joins, notified, receipts: input.receipts as ReceiptStore & { keys: Set<string> }, logs };
}

describe("scribe monitor arming", () => {
  it("arms a meeting entering its join window and records the receipt", async () => {
    const { m, joins, receipts } = monitor([meetingEvent()]);
    await m.tick();
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ instance_id: "inst-1", platform: "google_meet", meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(receipts.keys.size).toBe(1);
  });

  it("never double-arms when the receipt exists", async () => {
    const { m, joins, receipts } = monitor([meetingEvent()]);
    await m.tick();
    await m.tick();
    expect(joins).toHaveLength(1);
    expect(receipts.keys.size).toBe(1);
  });

  it("re-arms after a reschedule (new start)", async () => {
    const first = meetingEvent();
    const { m, joins } = monitor([first]);
    await m.tick();
    const moved = meetingEvent({ start: { dateTime: new Date(NOW + 20 * 60_000).toISOString() } });
    const { m: m2, joins: joins2 } = monitor([moved], fakeReceipts(), { now: NOW + 20 * 60_000 });
    await m2.tick();
    expect(joins.length + joins2.length).toBe(2);
    expect(armKey(first)).not.toBe(armKey(moved));
  });

  it("does nothing before the join window opens", async () => {
    const early = meetingEvent({ id: "early", start: { dateTime: new Date(NOW + 10 * 60_000).toISOString() } });
    const { m, joins, receipts, notified } = monitor([early]);
    await m.tick();
    expect(joins).toHaveLength(0);
    expect(receipts.keys.size).toBe(0);
    expect(notified).toHaveLength(0);
  });

  it("treats a worker refusal (at capacity) as terminal, not a retry loop", async () => {
    const receipts = fakeReceipts();
    let attempts = 0;
    const { m } = monitor([meetingEvent()], receipts, {
      joinWorker: async () => { attempts += 1; return { status: "failed" }; },
    });
    await m.tick();
    await m.tick();
    expect(attempts).toBe(1);
    expect(receipts.keys.size).toBe(1);
  });

  it("records a terminal receipt and notifies once when the worker is unreachable through the window", async () => {
    const receipts = fakeReceipts();
    let attempts = 0;
    const logs: string[] = [];
    const mk = (now: number) => monitor([meetingEvent()], receipts, {
      joinWorker: async () => { attempts += 1; throw new Error("ECONNREFUSED"); },
      now,
      logs,
    });
    // Inside the window: retries, no receipt, no notice.
    await mk(NOW).m.tick();
    await mk(NOW + 60_000).m.tick();
    expect(attempts).toBe(2);
    expect(receipts.keys.size).toBe(0);
    // Window closed (start + lateMax passed): terminal + one notice.
    const closed = mk(NOW + 10 * 60_000);
    await closed.m.tick();
    expect(closed.notified).toHaveLength(1);
    expect(closed.notified[0]).toMatchObject({ instance_id: "inst-1", reason: "capture service unreachable" });
    expect(receipts.keys.size).toBe(2); // arm + notify
    // Further ticks do nothing (receipt short-circuits).
    await mk(NOW + 11 * 60_000).m.tick();
    expect(closed.notified).toHaveLength(1);
  });
});

describe("scribe monitor quiet skips", () => {
  it("skips cancelled, all-day, no-link, foreign-host and self-organized events", async () => {
    const events: CalendarEvent[] = [
      meetingEvent({ id: "cancelled", status: "cancelled" }),
      meetingEvent({ id: "allday", start: { date: "2026-10-11" }, end: { date: "2026-10-12" } }),
      meetingEvent({ id: "nolink", hangoutLink: undefined, description: undefined, location: undefined, conferenceData: undefined }),
      meetingEvent({ id: "foreign", hangoutLink: undefined, description: "https://evil.example.com/meet", conferenceData: undefined }),
      meetingEvent({ id: "self", organizer: { email: SELF }, creator: { email: SELF } }),
    ];
    const { m, joins, receipts, notified } = monitor(events);
    await m.tick();
    expect(joins).toHaveLength(0);
    expect(receipts.keys.size).toBe(0);
    expect(notified).toHaveLength(0);
  });
});

describe("scribe monitor passcode hygiene", () => {
  it("carries the passcode only in the descriptor, never in logs or receipts", async () => {
    const withPasscode = meetingEvent({
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc", passcode: "SECRET-999" }] },
      hangoutLink: undefined,
    });
    const logs: string[] = [];
    const receipts = fakeReceipts();
    const { m } = monitor([withPasscode], receipts, { logs });
    await m.tick();
    // It reached the worker with the passcode...
    const descriptor = buildDescriptor(withPasscode, "https://meet.google.com/abc", "google_meet");
    expect(descriptor.passcode).toBe("SECRET-999");
    // ...but neither logs nor receipts contain it.
    expect(logs.join("\n")).not.toContain("SECRET-999");
    expect([...receipts.keys].join("\n")).not.toContain("SECRET-999");
    expect(passcodeFor(withPasscode, "https://meet.google.com/abc")).toBe("SECRET-999");
  });
});

describe("scribe monitor helpers", () => {
  it("resolves the platform from the host", () => {
    expect(platformForUrl("https://meet.google.com/x")).toBe("google_meet");
    expect(platformForUrl("https://us02web.zoom.us/j/123")).toBe("zoom");
    expect(platformForUrl("https://teams.live.com/meet/123")).toBe("teams");
    expect(platformForUrl("https://example.com/x")).toBeNull();
    expect(platformForUrl("not a url")).toBeNull();
  });

  it("extracts the join URL from a video entry point, then hangoutLink, then text", () => {
    expect(meetingUrlFor({ id: "1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/vid" }] } })).toBe("https://meet.google.com/vid");
    expect(meetingUrlFor({ id: "2", hangoutLink: "https://meet.google.com/hang" })).toBe("https://meet.google.com/hang");
    expect(meetingUrlFor({ id: "3", description: "join at https://meet.google.com/desc please" })).toBe("https://meet.google.com/desc");
    expect(meetingUrlFor({ id: "4" })).toBeNull();
  });

  it("reads a zoom passcode from the url query", () => {
    expect(passcodeFor({ id: "z" }, "https://us02web.zoom.us/j/123?pwd=abc123")).toBe("abc123");
  });

  it("builds a descriptor from the event", () => {
    const d = buildDescriptor(meetingEvent(), "https://meet.google.com/abc", "google_meet");
    expect(d.invitees).toEqual(["host@houseof434.com", "guest@example.com"]);
    expect(d.organizer_email).toBe("host@houseof434.com");
    expect(eventStartMs(meetingEvent())).toBe(NOW + 30_000);
  });
});

describe("scribe monitor reconciliation", () => {
  const seedArmed = (receipts: ReceiptStore, event: CalendarEvent): void => {
    receipts.record("scribe.arm", armKey(event)!, "armed", NOW);
  };

  it("sends a ready notice once for a completed meeting", async () => {
    const receipts = fakeReceipts();
    const event = meetingEvent();
    seedArmed(receipts, event);
    const { m, notified } = monitor([event], receipts, {
      status: async () => ({ status: "completed", segment_count: 12 }),
    });
    await m.tick();
    await m.tick();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ instance_id: "inst-1", kind: "completed", signedOut: false, segment_count: 12 });
    expect(receipts.keys.has("scribe.notify:inst-1")).toBe(true);
  });

  it("sends a failure notice, and flags admins when the profile is signed out", async () => {
    const receipts = fakeReceipts();
    const event = meetingEvent();
    seedArmed(receipts, event);
    const { m, notified } = monitor([event], receipts, {
      status: async () => ({ status: "failed", error: "relay@ browser profile is signed out — re-authenticate the Scribe profile" }),
    });
    await m.tick();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ kind: "failed", signedOut: true });
  });

  it("rate-limits the signed-out admin alert across meetings, but still notifies each organizer", async () => {
    const receipts = fakeReceipts();
    const a = meetingEvent({ id: "a" });
    const b = meetingEvent({ id: "b" });
    seedArmed(receipts, a);
    seedArmed(receipts, b);
    const { m, notified } = monitor([a, b], receipts, {
      status: async () => ({ status: "failed", error: "profile is signed out" }),
    });
    await m.tick();
    // Only the first meeting escalates to admins; both get the organizer notice.
    expect(notified.filter((n) => n.signedOut)).toHaveLength(1);
    expect(notified.filter((n) => n.kind === "failed")).toHaveLength(2);
  });

  it("writes a receipt but sends nothing for a skipped meeting", async () => {
    const receipts = fakeReceipts();
    const event = meetingEvent();
    seedArmed(receipts, event);
    const { m, notified } = monitor([event], receipts, { status: async () => ({ status: "skipped" }) });
    await m.tick();
    expect(notified).toHaveLength(0);
    expect(receipts.keys.has("scribe.notify:inst-1")).toBe(true);
  });

  it("keeps polling an unknown status, then gives up after the grace window", async () => {
    const receipts = fakeReceipts();
    const event = meetingEvent(); // ends NOW + 30.5 min; grace is 30 min
    seedArmed(receipts, event);
    const early = monitor([event], receipts, { status: async () => ({ status: "unknown" }) });
    await early.m.tick();
    expect(receipts.keys.has("scribe.notify:inst-1")).toBe(false);
    expect(early.notified).toHaveLength(0);
    // Past scheduled_end + grace: stop polling (receipt), still no notice.
    const late = monitor([event], receipts, { status: async () => ({ status: "unknown" }), now: NOW + 3_700_000 });
    await late.m.tick();
    expect(receipts.keys.has("scribe.notify:inst-1")).toBe(true);
    expect(late.notified).toHaveLength(0);
  });
});
