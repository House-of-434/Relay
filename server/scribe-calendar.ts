import { mailboxBffCall } from "./mailbox-bff.ts";
import type { CalendarEvent } from "./scribe-monitor.ts";

/** Lists relay@'s calendar over the BFF internal route. Reuses the shared
 * mailbox transport (PR 0): the BFF capability is passed in from the in-memory
 * holder and a fresh actor assertion is signed for relay@'s own account. The
 * route resolves the calendar from that actor, so no calendar id is supplied. */
export function createCalendarEventLister(options: {
  capability: string | undefined;
  maxResults?: number;
}): (timeMinIso: string, timeMaxIso: string) => Promise<CalendarEvent[]> {
  const maxResults = options.maxResults ?? 250;
  return async (timeMinIso: string, timeMaxIso: string) => {
    const response = await mailboxBffCall<{ events?: CalendarEvent[] }>(
      options.capability,
      "/api/internal/calendar/events/list",
      { timeMin: timeMinIso, timeMax: timeMaxIso, maxResults },
    );
    return response.events ?? [];
  };
}
