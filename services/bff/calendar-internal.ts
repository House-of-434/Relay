import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { verifyActorAssertion, type RelayActor } from "./actor-assertion.ts";
import { GOOGLE_API_SCOPE_CATALOG, GoogleApiGateway, MissingGoogleApiScopesError } from "./google-api.ts";
import type { GoogleConnectionMetadata } from "./google-connections.ts";

export const INTERNAL_CALENDAR_EVENTS_LIST = "/api/internal/calendar/events/list";
export const INTERNAL_CALENDAR_EVENTS_CREATE = "/api/internal/calendar/events/create";
export const INTERNAL_CALENDAR_EVENTS_UPDATE = "/api/internal/calendar/events/update";
export const INTERNAL_CALENDAR_EVENTS_DELETE = "/api/internal/calendar/events/delete";

const INTERNAL_CALENDAR_PATHS = [
  INTERNAL_CALENDAR_EVENTS_LIST,
  INTERNAL_CALENDAR_EVENTS_CREATE,
  INTERNAL_CALENDAR_EVENTS_UPDATE,
  INTERNAL_CALENDAR_EVENTS_DELETE,
] as const;

/** Events are always addressed on the owner's primary calendar. A caller can
 * never name another calendar, and a request may not move an event between
 * calendars, so one connection cannot reach the owner's other schedules. */
const PRIMARY = "primary";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 8_000;
const MAX_LOCATION = 500;
const MAX_ATTENDEES = 50;
const MAX_LIST_RESULTS = 250;
const MAX_RANGE_DAYS = 366;

const rfc3339 = z.string().datetime({ offset: true });
const eventId = z.string().min(1).max(512);
const attendeeEmail = z.string().email().max(320);
const attendees = z.array(attendeeEmail).max(MAX_ATTENDEES);

/**
 * Notification intent, not Google's vocabulary. The caller states whether the
 * user wants guests told; this decides the provider parameter. Omitted means
 * "whatever is normal", which is to notify whenever guests are involved — a
 * silent reschedule is the failure this replaces.
 */
const notify = z.enum(["default", "yes", "no"]);

function sendUpdatesFor(intent: z.infer<typeof notify> | undefined, guestsInvolved: boolean): "all" | "none" {
  if (intent === "no") return "none";
  return guestsInvolved || intent === "yes" ? "all" : "none";
}

/**
 * An attendee change is a partial edit of one guest, never a replacement of the
 * whole list. Google replaces the array wholesale, so the connector merges by
 * email: a guest the model did not name must survive the edit.
 */
const attendeeChange = z.object({
  email: attendeeEmail,
  responseStatus: z.enum(["accepted", "tentative", "declined"]).optional(),
  comment: z.string().max(MAX_DESCRIPTION).optional(),
}).strict();

/** Mirrors the MCP tool schema exactly: a timed event may carry its own time
 * zone, and an all-day event is a bare date. A mismatch here rejects a call the
 * model was explicitly told it could make. */
const eventTime = z.union([
  z.object({ dateTime: rfc3339, timeZone: z.string().min(1).max(64).optional() }).strict(),
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
]);

const listSchema = z.object({
  timeMin: rfc3339,
  timeMax: rfc3339,
  maxResults: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
}).strict();

const createSchema = z.object({
  summary: z.string().min(1).max(MAX_TITLE),
  start: eventTime,
  end: eventTime,
  description: z.string().max(MAX_DESCRIPTION).optional(),
  location: z.string().max(MAX_LOCATION).optional(),
  attendees: attendees.optional(),
  timeZone: z.string().min(1).max(64).optional(),
  notify: notify.optional(),
}).strict();

/** Patch-shaped on purpose: a caller who only moves a meeting should not have
 * to reconstruct the fields it is not changing. */
const updateSchema = z.object({
  eventId,
  summary: z.string().min(1).max(MAX_TITLE).optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  description: z.string().max(MAX_DESCRIPTION).optional(),
  location: z.string().max(MAX_LOCATION).optional(),
  attendees: z.array(attendeeChange).max(MAX_ATTENDEES).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  notify: notify.optional(),
}).strict();

const deleteSchema = z.object({ eventId, notify: notify.optional() }).strict();

export interface InternalCalendarOptions {
  googleApi: GoogleApiGateway;
  listAccounts: (userId: string) => Promise<GoogleConnectionMetadata[]>;
  capability: string;
  actorSecret: string | undefined;
  now?: () => number;
}

export function isInternalCalendarPath(pathname: string): boolean {
  return (INTERNAL_CALENDAR_PATHS as readonly string[]).includes(pathname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function capabilityMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (!match || Buffer.byteLength(match[1]!) > 4096) return false;
  return timingSafeEqual(hash(match[1]!), expectedHash);
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeSummary(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TITLE) : "";
}

function safeEventTime(value: unknown): { dateTime?: string; date?: string; timeZone?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.dateTime === "string") {
    return typeof record.timeZone === "string" ? { dateTime: record.dateTime, timeZone: record.timeZone } : { dateTime: record.dateTime };
  }
  if (typeof record.date === "string") return { date: record.date };
  return undefined;
}

function safeAttendees(raw: unknown): Array<{ email: string; responseStatus?: string; self?: boolean; organizer?: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const attendee = entry as Record<string, unknown>;
    if (typeof attendee.email !== "string" || !attendee.email.includes("@")) return [];
    return [{
      email: attendee.email.slice(0, 320),
      ...(typeof attendee.responseStatus === "string" ? { responseStatus: attendee.responseStatus } : {}),
      // Ownership facts Google computes and forbids the caller from setting.
      // Without them the assistant cannot tell whose meeting it is looking at.
      ...(typeof attendee.self === "boolean" ? { self: attendee.self } : {}),
      ...(typeof attendee.organizer === "boolean" ? { organizer: attendee.organizer } : {}),
    }];
  });
}

/** Identity of whoever created or organizes the event, used to refuse actions
 * the connected account has no standing to take. */
function safePrincipal(raw: unknown): { email?: string; self?: boolean } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const principal = raw as Record<string, unknown>;
  const shaped: { email?: string; self?: boolean } = {};
  if (typeof principal.email === "string" && principal.email.includes("@")) shaped.email = principal.email.slice(0, 320);
  if (typeof principal.self === "boolean") shaped.self = principal.self;
  return shaped.email || shaped.self !== undefined ? shaped : undefined;
}

function safeEvent(raw: unknown, accountEmail: string): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;
  const start = safeEventTime(event.start);
  const end = safeEventTime(event.end);
  if (typeof event.id !== "string" || !start || !end) return undefined;
  return {
    id: event.id,
    accountEmail,
    summary: safeSummary(event.summary),
    description: typeof event.description === "string" ? event.description.slice(0, MAX_DESCRIPTION) : undefined,
    location: typeof event.location === "string" ? event.location.slice(0, MAX_LOCATION) : undefined,
    status: event.status === "cancelled" ? "cancelled" : event.status === "tentative" ? "tentative" : "confirmed",
    start,
    end,
    htmlLink: typeof event.htmlLink === "string" ? event.htmlLink.slice(0, 1024) : undefined,
    updated: typeof event.updated === "string" ? event.updated : undefined,
    ...(safePrincipal(event.organizer) ? { organizer: safePrincipal(event.organizer) } : {}),
    ...(safePrincipal(event.creator) ? { creator: safePrincipal(event.creator) } : {}),
    attendees: safeAttendees(event.attendees),
  };
}

async function resolveCalendar(options: InternalCalendarOptions, actor: RelayActor): Promise<GoogleConnectionMetadata | undefined> {
  const calendars = (await options.listAccounts(actor.userId)).filter((account) => account.service === "google-calendar");
  if (calendars.length === 0) return undefined;
  if (calendars.length > 1) throw new Error("multiple connected calendars");
  return calendars[0]!;
}

/**
 * Calendar is reachable only for a verified actor and only for the single
 * calendar that actor connected. Every route requires the events scope for
 * writes and the read scope for reads; no caller-supplied identity, calendar,
 * or scope is honored, and no token or provider error leaves this boundary.
 *
 * The boundary is the shared capability plus the signed actor assertion, not
 * the peer's address: in the compose deployment the Tool Layer is a separate
 * container and is never a loopback peer.
 */
export async function handleInternalCalendar(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalCalendarOptions,
): Promise<void> {
  const expectedHash = hash(options.capability);
  req.resume();
  if (!capabilityMatches(req, expectedHash)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (!/^application\/json\b/i.test(headerString(req.headers["content-type"]) ?? "")) {
    json(res, 415, { error: "send the request as JSON" });
    return;
  }

  let actor: RelayActor;
  try {
    actor = verifyActorAssertion(
      headerString(req.headers["x-relay-actor-user"]),
      options.actorSecret,
      options.now?.() ?? Date.now(),
    );
  } catch {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    json(res, 400, { error: "invalid request body" });
    return;
  }

  let calendar: GoogleConnectionMetadata | undefined;
  try {
    calendar = await resolveCalendar(options, actor);
  } catch {
    json(res, 409, { error: "several calendars are connected for this user" });
    return;
  }
  if (!calendar) {
    json(res, 404, { error: "Google Calendar is not connected for this user" });
    return;
  }

  const writing = pathname !== INTERNAL_CALENDAR_EVENTS_LIST;
  const requiredScope = writing
    ? GOOGLE_API_SCOPE_CATALOG["google-calendar"].eventsWrite
    : GOOGLE_API_SCOPE_CATALOG["google-calendar"].read;

  try {
    if (pathname === INTERNAL_CALENDAR_EVENTS_LIST) {
      const parsed = listSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid calendar range" });
        return;
      }
      const start = Date.parse(parsed.data.timeMin);
      const finish = Date.parse(parsed.data.timeMax);
      if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start ||
          finish - start > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
        json(res, 400, { error: "invalid calendar range" });
        return;
      }
      const events = await options.googleApi.withClient(
        actor.userId,
        "google-calendar",
        calendar.id,
        [requiredScope],
        async (client) => {
          const response = await client.events.list({
            calendarId: PRIMARY,
            timeMin: parsed.data.timeMin,
            timeMax: parsed.data.timeMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: parsed.data.maxResults ?? MAX_LIST_RESULTS,
          });
          return (response.data.items ?? [])
            .map((item) => safeEvent(item, calendar!.email))
            .filter((item): item is Record<string, unknown> => Boolean(item));
        },
      );
      json(res, 200, { calendar: { email: calendar.email }, events });
      return;
    }

    if (pathname === INTERNAL_CALENDAR_EVENTS_CREATE) {
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid calendar event" });
        return;
      }
      const invitees = parsed.data.attendees ?? [];
      const notification = sendUpdatesFor(parsed.data.notify, invitees.length > 0);
      const created = await options.googleApi.withClient(
        actor.userId,
        "google-calendar",
        calendar.id,
        [requiredScope],
        async (client) => {
          const response = await client.events.insert({
            calendarId: PRIMARY,
            sendUpdates: notification,
            requestBody: {
              summary: parsed.data.summary,
              start: parsed.data.start,
              end: parsed.data.end,
              ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
              ...(parsed.data.location === undefined ? {} : { location: parsed.data.location }),
              ...(invitees.length === 0 ? {} : { attendees: invitees.map((email) => ({ email })) }),
              ...(parsed.data.timeZone === undefined ? {} : { timeZone: parsed.data.timeZone }),
            },
          });
          return safeEvent(response.data, calendar!.email);
        },
      );
      json(res, 200, {
        calendar: { email: calendar.email },
        event: created,
        invited: notification === "none" ? [] : invitees,
        notifications: notification,
      });
      return;
    }

    if (pathname === INTERNAL_CALENDAR_EVENTS_UPDATE) {
      const parsed = updateSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.eventId) {
        json(res, 400, { error: "invalid calendar event update" });
        return;
      }
      const { eventId: target, notify: intent, attendees: changes, ...patch } = parsed.data;
      const guestTouched = changes?.some((entry) => entry.responseStatus !== undefined) ?? false;
      let rejection: string | undefined;
      const updated = await options.googleApi.withClient(
        actor.userId,
        "google-calendar",
        calendar.id,
        [requiredScope],
        async (client) => {
          // Google replaces the attendee array wholesale, so merging a named
          // guest needs the current list first. Nothing else here does.
          let merged: Array<Record<string, unknown>> | undefined;
          if (changes !== undefined) {
            const current = await client.events.get({ calendarId: PRIMARY, eventId: target });
            const list = Array.isArray(current.data.attendees) ? current.data.attendees : [];
            const self = list.find((entry) => (entry as { self?: boolean }).self === true);
            if (guestTouched && !self) {
              // Answering someone else's meeting is not a thing. Saying so is
              // clearer than letting Google reject a shared-property edit.
              rejection = "the connected account is not an attendee of this event";
              return undefined;
            }
            const byEmail = new Map<string, Record<string, unknown>>();
            for (const entry of list) {
              const record = entry as Record<string, unknown>;
              const key = typeof record.email === "string" ? record.email.toLowerCase() : "";
              if (key) byEmail.set(key, { ...record });
            }
            for (const change of changes) {
              const key = change.email.toLowerCase();
              const mergedEntry = byEmail.get(key) ?? { email: change.email };
              if (change.responseStatus !== undefined) mergedEntry.responseStatus = change.responseStatus;
              if (change.comment !== undefined) mergedEntry.comment = change.comment;
              byEmail.set(key, mergedEntry);
            }
            merged = [...byEmail.values()];
          }
          // Notifying an event with no guests sends nothing, so the guest count
          // is irrelevant here and a plain edit costs one request. Only an
          // explicit "don't tell anyone" holds the notices back.
          const notification = intent === "no" ? "none" : "all";
          const response = await client.events.update({
            calendarId: PRIMARY,
            eventId: target,
            sendUpdates: notification,
            requestBody: {
              ...patch,
              ...(merged === undefined ? {} : { attendees: merged }),
            },
          });
          return { event: safeEvent(response.data, calendar!.email), notification };
        },
      );
      if (rejection) {
        json(res, 409, { error: rejection });
        return;
      }
      json(res, 200, { calendar: { email: calendar.email }, event: updated?.event, notifications: updated?.notification });
      return;
    }

    if (pathname === INTERNAL_CALENDAR_EVENTS_DELETE) {
      const parsed = deleteSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid calendar event deletion" });
        return;
      }
      const target = parsed.data.eventId;
      const notification = parsed.data.notify === "no" ? "none" : "all";
      let rejection: string | undefined;
      await options.googleApi.withClient(
        actor.userId,
        "google-calendar",
        calendar.id,
        [requiredScope],
        async (client) => {
          if (notification === "all") {
            // Telling guests a meeting is off is the organizer's call. Anyone
            // else deleting their own copy is fine, but it must not pretend to
            // have cancelled the meeting.
            const current = await client.events.get({ calendarId: PRIMARY, eventId: target });
            const organizer = (current.data.organizer as { self?: boolean } | undefined)?.self === true;
            const hasGuests = Array.isArray(current.data.attendees) && current.data.attendees.length > 0;
            if (!organizer && hasGuests) {
              rejection = "the connected account does not organize this event, so attendees cannot be notified";
              return;
            }
          }
          await client.events.delete({ calendarId: PRIMARY, eventId: target, sendUpdates: notification });
          return true;
        },
      );
      if (rejection) {
        json(res, 409, { error: rejection });
        return;
      }
      json(res, 200, { calendar: { email: calendar.email }, deleted: target, notifications: notification });
      return;
    }
  } catch (error) {
    // A read-only grant cannot write. Say so plainly: the owner has to
    // reconnect, and an opaque provider failure would read as a transient bug
    // and invite blind retries.
    if (error instanceof MissingGoogleApiScopesError) {
      json(res, 409, {
        error: writing
          ? "Google Calendar is connected read-only. Reconnect Calendar to allow changes."
          : "Google Calendar is not connected with the required permission. Reconnect Calendar.",
      });
      return;
    }
    json(res, 502, { error: "Google Calendar request failed" });
  }
}