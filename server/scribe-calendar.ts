import { mailboxBffCall, type MailboxActor } from "./mailbox-bff.ts";
import type { CalendarEvent } from "./scribe-monitor.ts";

/** Lists relay@'s calendar over the BFF internal route. Reuses the shared
 * mailbox transport (PR 0): the BFF capability is passed in from the in-memory
 * holder and the caller supplies relay@'s own per-user actor (its user id
 * plus a Mercury bot and thread). The route resolves the calendar from that
 * actor's user id, so no calendar id is supplied.
 *
 * Uses the monitor-only `list-join` projection: the agent-facing route strips
 * hangoutLink/conferenceData/recurringEventId/originalStartTime, so the monitor
 * would otherwise have no meeting URL. The literal is duplicated rather than
 * imported so the harness never pulls the BFF's zod/google-api modules. */
const CALENDAR_EVENTS_LIST_JOIN = "/api/internal/calendar/events/list-join";

export function createCalendarEventLister(options: {
  capability: string | undefined;
  actor: MailboxActor;
  maxResults?: number;
}): (timeMinIso: string, timeMaxIso: string) => Promise<CalendarEvent[]> {
  const maxResults = options.maxResults ?? 250;
  return async (timeMinIso: string, timeMaxIso: string) => {
    const response = await mailboxBffCall<{ events?: CalendarEvent[] }>(
      options.capability,
      CALENDAR_EVENTS_LIST_JOIN,
      { timeMin: timeMinIso, timeMax: timeMaxIso, maxResults },
      options.actor,
    );
    return response.events ?? [];
  };
}
