import assert from "node:assert/strict";
import { test } from "node:test";

import { CALENDAR_INTERNAL_PATHS, CalendarRequestError, RelayCalendarClient } from "./infra/calendar.js";
import { authorizeCalendar, CALENDAR_PERMISSIONS } from "./domain/permissions.js";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR = '{"userId":"1457cb2a-7543-4b48-8854-a63cd160241f","email":"one@houseof434.com"}';
const DRAFT = {
  summary: "Design review",
  start: { dateTime: "2026-01-06T09:00:00Z" },
  end: { dateTime: "2026-01-06T10:00:00Z" },
};

test("only Mercury may use the calendar, and writes are separable from reads", () => {
  assert.deepEqual([...CALENDAR_PERMISSIONS.mercury].sort(), ["create", "delete", "read", "respond", "update"]);
  assert.deepEqual(CALENDAR_PERMISSIONS.scout, []);
  assert.deepEqual(CALENDAR_PERMISSIONS.curator, []);

  for (const capability of ["read", "create", "update", "delete", "respond"] as const) {
    assert.doesNotThrow(() => authorizeCalendar("mercury", capability));
  }
  assert.throws(() => authorizeCalendar("scout", "read"), /calendar read access denied for scout/);
  assert.throws(() => authorizeCalendar("curator", "create"), /calendar create access denied for curator/);
  assert.throws(() => authorizeCalendar("curator", "respond"), /calendar respond access denied for curator/);
});

test("the client speaks notification intent, never the provider's vocabulary", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return Response.json({ calendar: { email: "one@example.com" }, event: undefined });
    }) as typeof fetch,
  });

  await client.createEvent(ACTOR, { ...DRAFT, notify: "yes" });
  await client.updateEvent(ACTOR, { eventId: "event-1", summary: "Moved" });
  await client.updateEvent(ACTOR, {
    eventId: "event-1",
    attendees: [{ email: "one@houseof434.com", responseStatus: "declined" }],
  });
  await client.deleteEvent(ACTOR, { eventId: "event-1", notify: "no" });

  const bodies = seen.map((entry) => JSON.parse(String(entry.init.body)) as Record<string, unknown>);
  // A patch carries only what changed: no forced reconstruction of the event.
  assert.deepEqual(Object.keys(bodies[1]!).sort(), ["eventId", "summary"]);
  assert.equal(bodies[2]!.attendees !== undefined, true);
  const serialized = JSON.stringify(bodies);
  assert.equal(serialized.includes("sendUpdates"), false);
});

test("the calendar client forwards the actor assertion and capability, never a user id", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return Response.json({ calendar: { email: "one@example.com" }, events: [] });
    }) as typeof fetch,
  });

  await client.listEvents(ACTOR, { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-08T00:00:00Z" });

  const headers = new Headers(seen[0]!.init.headers);
  assert.equal(seen[0]!.url, `http://127.0.0.1:8798${CALENDAR_INTERNAL_PATHS.eventsList}`);
  assert.equal(headers.get("authorization"), `Bearer ${CAPABILITY}`);
  assert.equal(headers.get("x-relay-actor-user"), ACTOR);
  assert.equal(headers.get("content-type"), "application/json");
  assert.doesNotMatch(JSON.stringify(seen[0]!.init.body ?? ""), /userId|accountId|email/);
});

test("every calendar write goes to a scoped, account-less path", async () => {
  const seen: string[] = [];
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL) => {
      seen.push(String(input));
      return Response.json({ calendar: { email: "one@example.com" }, event: {}, deleted: "event-1" });
    }) as typeof fetch,
  });

  await client.createEvent(ACTOR, DRAFT);
  await client.updateEvent(ACTOR, { eventId: "event-1", summary: "v2" });
  await client.deleteEvent(ACTOR, { eventId: "event-1" });

  assert.deepEqual(seen, [
    `http://127.0.0.1:8798${CALENDAR_INTERNAL_PATHS.eventsCreate}`,
    `http://127.0.0.1:8798${CALENDAR_INTERNAL_PATHS.eventsUpdate}`,
    `http://127.0.0.1:8798${CALENDAR_INTERNAL_PATHS.eventsDelete}`,
  ]);
});

test("the calendar client refuses to run without a usable capability", async () => {
  let called = false;
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: "too-short",
    fetcher: (async () => { called = true; return Response.json({}); }) as typeof fetch,
  });

  await assert.rejects(() => client.createEvent(ACTOR, DRAFT), (error: unknown) => {
    assert.ok(error instanceof CalendarRequestError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(called, false);
});

test("BFF refusals surface as errors without leaking provider detail", async () => {
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => new Response(
      JSON.stringify({ error: "Google Calendar is not connected for this user" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )) as typeof fetch,
  });

  await assert.rejects(
    () => client.deleteEvent(ACTOR, { eventId: "event-1" }),
    /Google Calendar is not connected for this user/,
  );
});

test("an unreachable BFF is reported as such rather than silently succeeding", async () => {
  const client = new RelayCalendarClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });

  await assert.rejects(
    () => client.createEvent(ACTOR, DRAFT),
    /Google Calendar service is unreachable/,
  );
});

test("only the four calendar paths are ever called", () => {
  assert.deepEqual(Object.values(CALENDAR_INTERNAL_PATHS).sort(), [
    "/api/internal/calendar/events/create",
    "/api/internal/calendar/events/delete",
    "/api/internal/calendar/events/list",
    "/api/internal/calendar/events/update",
  ]);
});
test("Mercury's calendar surface states intent, not the provider's parameters", async () => {
  const { createAgentMcpServer } = await import("./mcp/agent-server.js");
  const captured: Array<{ name: string; args: unknown[] }> = [];
  const client = {
    listEvents: async (...args: unknown[]) => { captured.push({ name: "listEvents", args }); return { events: [] }; },
    createEvent: async (...args: unknown[]) => { captured.push({ name: "createEvent", args }); return {}; },
    updateEvent: async (...args: unknown[]) => { captured.push({ name: "updateEvent", args }); return {}; },
    deleteEvent: async (...args: unknown[]) => { captured.push({ name: "deleteEvent", args }); return {}; },
  };
  const mcp = createAgentMcpServer(
    "mercury",
    null,
    {} as never,
    undefined,
    { client: client as never, actorAssertion: ACTOR },
  );

  const listing = (mcp as unknown as {
    _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }>;
  })._registeredTools;
  assert.deepEqual(Object.keys(listing).sort(), [
    "calendar_create_event",
    "calendar_delete_event",
    "calendar_list_events",
    "calendar_update_event",
    "relay_read",
    "relay_write",
  ]);

  const update = listing.calendar_update_event!.inputSchema.shape;
  // Update is patch-shaped: no required summary/start/end to reconstruct.
  assert.deepEqual(Object.keys(update).sort(), [
    "attendees", "description", "end", "eventId", "location", "notify", "start", "summary", "timeZone",
  ]);
  assert.equal(JSON.stringify(listing).includes("sendUpdates"), false);
  assert.equal(JSON.stringify(listing).includes("attendeesOmitted"), false);
});
