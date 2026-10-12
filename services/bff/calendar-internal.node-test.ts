import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { GOOGLE_API_SCOPE_CATALOG, MissingGoogleApiScopesError, type GoogleApiGateway } from "./google-api.ts";
import { GoogleConnectionStore } from "./google-connections.ts";
import {
  handleInternalCalendar,
  INTERNAL_CALENDAR_EVENTS_CREATE,
  INTERNAL_CALENDAR_EVENTS_DELETE,
  INTERNAL_CALENDAR_EVENTS_LIST,
  INTERNAL_CALENDAR_EVENTS_UPDATE,
  isInternalCalendarPath,
} from "./calendar-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const WRONG_SECRET = "internal-actor-secret-WRONG-0000000000000000000000";
const TOKEN_KEY = "a".repeat(64);
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const USER_EMAIL = "one@houseof434.com";
const RANGE = { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-08T00:00:00Z" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function actorAssertion(userId: string, email: string, issuedAt = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify([userId, email, issuedAt]))
    .digest("base64url");
  return JSON.stringify({ userId, email, issuedAt, signature });
}

interface CalendarCall { userId: string; accountId: string; operation: string; params: Record<string, unknown> }

interface SeededEvent {
  id?: string;
  summary?: string;
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<Record<string, unknown>>;
}

function calendarGateway(
  calls: CalendarCall[],
  behaviour: "ok" | "fail" = "ok",
  seeded: SeededEvent = {},
): GoogleApiGateway {
  const existing = {
    id: seeded.id ?? "event-1",
    summary: seeded.summary ?? "Design review",
    organizer: seeded.organizer ?? { email: "one@houseof434.com", self: true },
    attendees: seeded.attendees ?? [
      { email: "one@houseof434.com", responseStatus: "accepted", self: true, organizer: true },
      { email: "friend@example.test", responseStatus: "needsAction" },
    ],
    start: { dateTime: "2026-01-05T09:00:00Z" },
    end: { dateTime: "2026-01-05T09:30:00Z" },
  };
  const client = {
    events: {
      list: async (params: Record<string, unknown>) => {
        calls.push({ userId: "", accountId: "", operation: "events.list", params });
        if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
        return { data: { items: [{ id: "event-1", summary: "Standup", start: { dateTime: "2026-01-05T09:00:00Z" }, end: { dateTime: "2026-01-05T09:30:00Z" } }] } };
      },
      get: async (params: Record<string, unknown>) => {
        calls.push({ userId: "", accountId: "", operation: "events.get", params });
        if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
        return { data: existing };
      },
      insert: async (params: Record<string, unknown>) => {
        calls.push({ userId: "", accountId: "", operation: "events.insert", params });
        if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
        return { data: { id: "created-1", summary: "New", start: { dateTime: "2026-01-06T09:00:00Z" }, end: { dateTime: "2026-01-06T10:00:00Z" } } };
      },
      update: async (params: Record<string, unknown>) => {
        calls.push({ userId: "", accountId: "", operation: "events.update", params });
        if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
        return { data: { ...existing, ...(params.requestBody as Record<string, unknown> | undefined), id: String(params.eventId) } };
      },
      delete: async (params: Record<string, unknown>) => {
        calls.push({ userId: "", accountId: "", operation: "events.delete", params });
        if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
        return { data: {} };
      },
    },
  };
  return {
    withClient: async (
      userId: string,
      _service: string,
      _accountId: string,
      scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => {
      calls.push({ userId, accountId: _accountId, operation: `withClient:${scopes.join("+")}`, params: {} });
      return operation(client);
    },
  } as unknown as GoogleApiGateway;
}

interface SeededAccount { userId: string; service: "gmail" | "google-calendar"; googleSub: string; email: string }

function readOnlyCalendarGateway(): GoogleApiGateway {
  return {
    withClient: async (
      _userId: string,
      _service: string,
      _accountId: string,
      scopes: readonly string[],
      _operation: (client: unknown) => unknown,
    ) => {
      if (!scopes.includes(GOOGLE_API_SCOPE_CATALOG["google-calendar"].read)) {
        throw new MissingGoogleApiScopesError([GOOGLE_API_SCOPE_CATALOG["google-calendar"].read]);
      }
      if (scopes.length === 1) return [];
      throw new MissingGoogleApiScopesError([GOOGLE_API_SCOPE_CATALOG["google-calendar"].eventsWrite as never]);
    },
  } as unknown as GoogleApiGateway;
}

async function createFixture(options: { gateway?: GoogleApiGateway; accounts?: SeededAccount[]; seeded?: SeededEvent } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-calendar-internal-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: TOKEN_KEY });
  for (const account of options.accounts ?? []) {
    await store.save({ ...account, refreshToken: `refresh-token-for-${account.googleSub}` });
  }

  const calls: CalendarCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalCalendar(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      googleApi: options.gateway ?? calendarGateway(calls, "ok", options.seeded),
      listAccounts: (userId) => store.list(userId),
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, `http://127.0.0.1:${port}`), init);
  const post = (path: string, body: unknown, assertion: string, capability = CAPABILITY) =>
    call(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "x-relay-actor-user": assertion,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const list = (assertion = actorAssertion(USER_ID, USER_EMAIL)) => post(INTERNAL_CALENDAR_EVENTS_LIST, RANGE, assertion);

  return { call, post, list, calls };
}

test("the BFF derives the calendar from the verified actor and refuses one named in the request", async () => {
  const { list, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });

  const injected = await list();
  assert.equal(injected.status, 200);
  assert.equal((await injected.json() as { calendar: { email: string } }).calendar.email, "one@example.com");

  const named = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const refused = await named.post(
    INTERNAL_CALENDAR_EVENTS_LIST,
    { ...RANGE, calendarId: "someone-elses-calendar", userId: OTHER_USER_ID },
    actorAssertion(USER_ID, USER_EMAIL),
  );
  assert.equal(refused.status, 400);
  assert.equal(calls.every((call) => call.userId === "" || call.userId === USER_ID), true);
});

test("every calendar route is addressed to the owner's primary calendar only", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Design review",
    start: { dateTime: "2026-01-06T09:00:00Z" },
    end: { dateTime: "2026-01-06T10:00:00Z" },
  }, assertion);
  await post(INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", summary: "Design review v2" }, assertion);
  await post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1" }, assertion);

  const addressed = calls.filter((call) => call.params.calendarId !== undefined);
  // create, the plain update's single write, and the delete's read plus write.
  assert.equal(addressed.length, 4);
  assert.equal(addressed.every((call) => call.params.calendarId === "primary"), true);
  // The actor's email is never forwarded to Google as an authority.
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes(OTHER_USER_ID), false);
  assert.equal(serialized.includes("refresh-token-for-"), false);
});

test("reads require the read scope and every write requires the events scope", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  await post(INTERNAL_CALENDAR_EVENTS_LIST, RANGE, assertion);
  await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Design review",
    start: { dateTime: "2026-01-06T09:00:00Z" },
    end: { dateTime: "2026-01-06T10:00:00Z" },
  }, assertion);
  await post(INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", summary: "v2" }, assertion);
  await post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1" }, assertion);

  assert.deepEqual(
    calls.filter((call) => call.operation.startsWith("withClient:")).map((call) => call.operation),
    [
      `withClient:${GOOGLE_API_SCOPE_CATALOG["google-calendar"].read}`,
      `withClient:${GOOGLE_API_SCOPE_CATALOG["google-calendar"].eventsWrite}`,
      `withClient:${GOOGLE_API_SCOPE_CATALOG["google-calendar"].eventsWrite}`,
      `withClient:${GOOGLE_API_SCOPE_CATALOG["google-calendar"].eventsWrite}`,
    ],
  );
});

test("missing or invalid capability is rejected before any Google work", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, RANGE, assertion, "wrong-capability-value-long-enough-here")).status, 401);
  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "e" }, assertion, "wrong-capability-value-long-enough-here")).status, 401);
  assert.equal(calls.length, 0);
});

test("an assertion signed with another secret is rejected", async () => {
  const { list } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const issuedAt = Math.floor(Date.now() / 1000);
  const resigned = JSON.stringify({
    userId: OTHER_USER_ID,
    email: "other@houseof434.com",
    issuedAt,
    signature: createHmac("sha256", WRONG_SECRET)
      .update(JSON.stringify([OTHER_USER_ID, "other@houseof434.com", issuedAt]))
      .digest("base64url"),
  });
  assert.equal((await list(resigned)).status, 401);
});

test("an expired actor assertion is rejected", async () => {
  const { list } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  assert.equal((await list(actorAssertion(USER_ID, USER_EMAIL, Math.floor(Date.now() / 1000) - 3600))).status, 401);
});

test("calendar ranges are bounded and ordered", async () => {
  const { post } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, { timeMin: "2026-01-08T00:00:00Z", timeMax: "2026-01-01T00:00:00Z" }, assertion)).status, 400);
  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, { timeMin: "2026-01-01T00:00:00Z", timeMax: "2028-01-01T00:00:00Z" }, assertion)).status, 400);
  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, { timeMin: "not-a-date", timeMax: "2026-01-08T00:00:00Z" }, assertion)).status, 400);
  // A duplicated bound is never silently honoured.
  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, [RANGE], assertion)).status, 400);
});

test("unconnected and ambiguous actors fail clearly instead of guessing a calendar", async () => {
  const unconnected = await createFixture({ accounts: [] });
  assert.equal((await unconnected.list()).status, 404);

  const ambiguous = await createFixture({
    accounts: [
      { userId: USER_ID, service: "google-calendar", googleSub: "first", email: "first@example.com" },
      { userId: USER_ID, service: "google-calendar", googleSub: "second", email: "second@example.com" },
    ],
  });
  assert.equal((await ambiguous.list()).status, 409);
});

test("no token or raw provider error escapes the BFF", async () => {
  const { post } = await createFixture({
    gateway: calendarGateway([], "fail"),
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  for (const [path, body] of [
    [INTERNAL_CALENDAR_EVENTS_LIST, RANGE],
    [INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1" }],
  ] as const) {
    const response = await post(path, body, assertion);
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes("refresh-token-for-"), false);
    assert.equal(text.includes("provider exploded"), false);
    assert.equal(text.includes("secret token"), false);
  }
});

test("only the four calendar routes are reachable", () => {
  for (const path of [
    INTERNAL_CALENDAR_EVENTS_LIST,
    INTERNAL_CALENDAR_EVENTS_CREATE,
    INTERNAL_CALENDAR_EVENTS_UPDATE,
    INTERNAL_CALENDAR_EVENTS_DELETE,
    ]) {
    assert.equal(isInternalCalendarPath(path), true);
    assert.equal(path.startsWith("/api/internal/"), true);
  }
  for (const path of [
    "/api/internal/calendar/acl/update",
    "/api/internal/calendar/freebusy",
    "/api/internal/gmail/messages/list",
    "/api/google/calendar/events",
  ]) {
    assert.equal(isInternalCalendarPath(path), false);
  }
});

test("the BFF accepts exactly the shapes the MCP tool schema advertises", async () => {
  // A mismatch here rejects a call the model was told it could make, which is
  // how a swap of two meetings failed on a nested timeZone and sendUpdates.
  const { post } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  const accepted: Array<[string, unknown]> = [
    [INTERNAL_CALENDAR_EVENTS_CREATE, {
      summary: "Design review",
      start: { dateTime: "2026-10-02T19:00:00Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-02T20:00:00Z", timeZone: "America/New_York" },
    }],
    [INTERNAL_CALENDAR_EVENTS_CREATE, {
      summary: "All day",
      start: { date: "2026-10-03" },
      end: { date: "2026-10-04" },
    }],
    [INTERNAL_CALENDAR_EVENTS_CREATE, {
      summary: "With guests",
      start: { dateTime: "2026-10-02T19:00:00Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-02T20:00:00Z", timeZone: "America/New_York" },
      attendees: ["friend@example.test"],
      notify: "yes",
    }],
    [INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", summary: "Moved" }],
    [INTERNAL_CALENDAR_EVENTS_UPDATE, {
      eventId: "event-1",
      start: { dateTime: "2026-10-02T19:00:00Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-02T20:00:00Z", timeZone: "America/New_York" },
      notify: "default",
    }],
    [INTERNAL_CALENDAR_EVENTS_UPDATE, {
      eventId: "event-1",
      attendees: [{ email: "one@houseof434.com", responseStatus: "declined", comment: "Out sick" }],
    }],
    [INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", notify: "no", summary: "Quietly renamed" }],
    [INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1", notify: "no" }],
  ];

  for (const [path, body] of accepted) {
    const response = await post(path, body, assertion);
    assert.equal(response.status, 200, `${path} ${JSON.stringify(body)} -> ${await response.clone().text()}`);
  }

  // Genuinely unknown fields are still refused rather than silently dropped, so
  // Google's own vocabulary never becomes a way in.
  for (const raw of [
    { eventId: "event-1", calendarId: "other" },
    { eventId: "event-1", sendUpdates: "all" },
    { eventId: "event-1", attendeesOmitted: true },
    { eventId: "event-1", changes: { summary: "x" } },
  ]) {
    const unknown = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, raw, assertion);
    assert.equal(unknown.status, 400, `expected ${JSON.stringify(raw)} to be refused`);
  }
});

test("a read-only grant is refused with a reconnect instruction, not an opaque failure", async () => {
  const { post } = await createFixture({
    gateway: readOnlyCalendarGateway(),
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  const update = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", summary: "Moved" }, assertion);
  assert.equal(update.status, 409);
  assert.match((await update.text()).toLowerCase(), /reconnect/);

  // Reads still work on a read-only grant.
  assert.equal((await post(INTERNAL_CALENDAR_EVENTS_LIST, RANGE, assertion)).status, 200);
});

test("answering an invitation never drops the other guests", async () => {
  // Google replaces the attendee array wholesale, so a caller that sends back
  // only its own seat silently unsubscribes everyone else. The merge is what
  // makes a one-line RSVP safe.
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  const response = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    attendees: [{ email: "one@houseof434.com", responseStatus: "declined", comment: "Out sick" }],
  }, assertion);
  assert.equal(response.status, 200);

  const update = calls.find((call) => call.operation === "events.update")!;
  const sent = (update.params.requestBody as { attendees: Array<Record<string, unknown>> }).attendees;
  assert.deepEqual(sent.map((entry) => entry.email), [
    "one@houseof434.com",
    "friend@example.test",
  ]);
  assert.equal(sent[0]!.responseStatus, "declined");
  assert.equal(sent[0]!.comment, "Out sick");
  assert.equal(sent[1]!.responseStatus, "needsAction");
  // The organizer learns their own response changed.
  assert.equal(update.params.sendUpdates, "all");
});

test("an unnamed guest keeps their seat and a new guest is added", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const response = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    attendees: [{ email: "newcomer@example.test" }],
  }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(response.status, 200);

  const update = calls.find((call) => call.operation === "events.update")!;
  const sent = (update.params.requestBody as { attendees: Array<Record<string, unknown>> }).attendees;
  assert.deepEqual(sent.map((entry) => entry.email).sort(), [
    "friend@example.test",
    "newcomer@example.test",
    "one@houseof434.com",
  ]);
});

test("declining someone else's invitation is refused, not attempted", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
    seeded: {
      organizer: { email: "boss@example.test", self: false },
      attendees: [{ email: "boss@example.test", organizer: true, self: false }],
    },
  });
  const response = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    attendees: [{ email: "one@houseof434.com", responseStatus: "declined" }],
  }, actorAssertion(USER_ID, USER_EMAIL));

  assert.equal(response.status, 409);
  assert.match((await response.text()).toLowerCase(), /not an attendee/);
  assert.equal(calls.some((call) => call.operation === "events.update"), false);
});

test("guests are told by default, because a silent reschedule is the bug", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  await post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    start: { dateTime: "2026-10-02T19:00:00Z" },
    end: { dateTime: "2026-10-02T20:00:00Z" },
  }, assertion);
  const moved = calls.find((call) => call.operation === "events.update")!;
  assert.equal(moved.params.sendUpdates, "all");

  // Only an explicit request to stay quiet suppresses it.
  await post(INTERNAL_CALENDAR_EVENTS_UPDATE, { eventId: "event-1", summary: "Quietly renamed", notify: "no" }, assertion);
  const quiet = calls.filter((call) => call.operation === "events.update").at(-1)!;
  assert.equal(quiet.params.sendUpdates, "none");
});

test("creating an event with guests invites them, and notify:no holds that back", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  const created = await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Coffee",
    start: { dateTime: "2026-10-02T15:00:00Z" },
    end: { dateTime: "2026-10-02T16:00:00Z" },
    attendees: ["friend@example.test"],
  }, assertion);
  assert.equal(created.status, 200);
  const body = await created.json() as { invited: string[]; notifications: string };
  assert.equal(body.notifications, "all");
  assert.deepEqual(body.invited, ["friend@example.test"]);

  const insert = calls.find((call) => call.operation === "events.insert")!;
  assert.equal(insert.params.sendUpdates, "all");
  assert.deepEqual((insert.params.requestBody as { attendees: unknown[] }).attendees, [{ email: "friend@example.test" }]);

  // The user's own calendar is nobody else's business.
  const solo = await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Focus",
    start: { dateTime: "2026-10-02T17:00:00Z" },
    end: { dateTime: "2026-10-02T18:00:00Z" },
  }, assertion);
  assert.equal((await solo.json() as { notifications: string }).notifications, "none");

  const held = await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Coffee later",
    start: { dateTime: "2026-10-03T15:00:00Z" },
    end: { dateTime: "2026-10-03T16:00:00Z" },
    attendees: ["friend@example.test"],
    notify: "no",
  }, assertion);
  assert.equal((await held.json() as { notifications: string }).notifications, "none");
});

test("cancelling tells the guests, but only the organizer may do it", async () => {
  const organizer = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const cancelled = await organizer.post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1" }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(cancelled.status, 200);
  const removal = organizer.calls.find((call) => call.operation === "events.delete")!;
  assert.equal(removal.params.sendUpdates, "all");

  const guest = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
    seeded: {
      organizer: { email: "boss@example.test", self: false },
      attendees: [{ email: "boss@example.test", organizer: true, self: false }],
    },
  });
  const refused = await guest.post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1" }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(refused.status, 409);
  assert.equal(guest.calls.some((call) => call.operation === "events.delete"), false);

  // Leaving one's own copy is still allowed; it just claims nothing.
  const quiet = await guest.post(INTERNAL_CALENDAR_EVENTS_DELETE, { eventId: "event-1", notify: "no" }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(quiet.status, 200);
  assert.equal(guest.calls.find((call) => call.operation === "events.delete")!.params.sendUpdates, "none");
});

test("the sanitized event says who owns it and who each guest is", async () => {
  const { post } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const response = await post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    attendees: [{ email: "one@houseof434.com", responseStatus: "tentative" }],
  }, actorAssertion(USER_ID, USER_EMAIL));

  const { event } = await response.json() as { event: Record<string, unknown> };
  assert.deepEqual(event.organizer, { email: "one@houseof434.com", self: true });
  const attendees = event.attendees as Array<Record<string, unknown>>;
  assert.equal(attendees[0]!.self, true);
  assert.equal(attendees[0]!.organizer, true);
  assert.equal(attendees[1]!.responseStatus, "needsAction");
});

test("a plain edit costs one request; only an attendee change needs a read", async () => {
  // The read exists to merge guests, not to decide whether to notify: telling
  // Google to notify an event with no guests sends nothing.
  const plain = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const moved = await plain.post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    start: { dateTime: "2026-10-02T19:00:00Z" },
    end: { dateTime: "2026-10-02T20:00:00Z" },
  }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(moved.status, 200);
  assert.equal(plain.calls.some((call) => call.operation === "events.get"), false);
  assert.equal(plain.calls.filter((call) => call.operation === "events.update").length, 1);
  assert.equal((await moved.json() as { notifications: string }).notifications, "all");

  const rsvp = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  await rsvp.post(INTERNAL_CALENDAR_EVENTS_UPDATE, {
    eventId: "event-1",
    attendees: [{ email: "one@houseof434.com", responseStatus: "declined" }],
  }, actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(rsvp.calls.some((call) => call.operation === "events.get"), true);
  assert.equal(rsvp.calls.filter((call) => call.operation === "events.update").length, 1);
});

test("a non-address attendee is refused instead of creating a silently uninvited guest", async () => {
  const { post, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "google-calendar", googleSub: "cal-sub", email: "one@example.com" }],
  });
  const response = await post(INTERNAL_CALENDAR_EVENTS_CREATE, {
    summary: "Coffee",
    start: { dateTime: "2026-10-02T15:00:00Z" },
    end: { dateTime: "2026-10-02T16:00:00Z" },
    attendees: ["my friend Sam"],
  }, actorAssertion(USER_ID, USER_EMAIL));

  assert.equal(response.status, 400);
  assert.equal(calls.some((call) => call.operation === "events.insert"), false);
});
