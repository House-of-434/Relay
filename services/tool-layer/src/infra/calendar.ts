export const CALENDAR_INTERNAL_PATHS = {
  eventsList: "/api/internal/calendar/events/list",
  eventsCreate: "/api/internal/calendar/events/create",
  eventsUpdate: "/api/internal/calendar/events/update",
  eventsDelete: "/api/internal/calendar/events/delete",
} as const;

export interface CalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEventAttendee {
  email: string;
  responseStatus?: string;
  /** Whether this entry is the connected account. Google computes it. */
  self?: boolean;
  /** Whether this entry organizes the event. Google computes it. */
  organizer?: boolean;
}

export interface CalendarPrincipal {
  email?: string;
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  accountEmail: string;
  summary: string;
  description?: string;
  location?: string;
  status: "confirmed" | "tentative" | "cancelled";
  start: CalendarEventTime;
  end: CalendarEventTime;
  htmlLink?: string;
  updated?: string;
  organizer?: CalendarPrincipal;
  creator?: CalendarPrincipal;
  attendees?: CalendarEventAttendee[];
}

/** Notification intent, not a provider parameter. */
export type NotifyIntent = "default" | "yes" | "no";

export interface CalendarEventDraft {
  summary: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
  notify?: NotifyIntent;
}

/** Only the fields that should change. Absent means unchanged. */
export interface CalendarEventChanges {
  summary?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; responseStatus?: string; comment?: string }>;
  timeZone?: string;
}

export class CalendarRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CalendarRequestError";
    this.status = status;
  }
}

export interface RelayCalendarClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

/**
 * The Tool Layer never holds a Google credential. It authorizes the operation,
 * then asks the BFF to run it using the signed actor assertion it already
 * verified. The BFF derives the calendar from that verified identity, so no
 * agent can address a calendar the signed-in user did not connect.
 */
export class RelayCalendarClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayCalendarClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async call<Result>(path: string, actorAssertion: string, payload: unknown): Promise<Result> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new CalendarRequestError(503, "the Google Calendar service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new CalendarRequestError(502, "the Google Calendar service is unreachable");
    }
    if (!response.ok) {
      throw new CalendarRequestError(response.status, await safeErrorMessage(response));
    }
    return await response.json() as Result;
  }

  listEvents(actorAssertion: string, input: { timeMin: string; timeMax: string; maxResults?: number }) {
    return this.call<{ calendar: { email: string }; events: CalendarEvent[] }>(
      CALENDAR_INTERNAL_PATHS.eventsList,
      actorAssertion,
      input,
    );
  }

  createEvent(actorAssertion: string, input: CalendarEventDraft) {
    return this.call<{ calendar: { email: string }; event: CalendarEvent | undefined; invited?: string[]; notifications?: string }>(
      CALENDAR_INTERNAL_PATHS.eventsCreate,
      actorAssertion,
      input,
    );
  }

  updateEvent(
    actorAssertion: string,
    input: CalendarEventChanges & { eventId: string; notify?: NotifyIntent },
  ) {
    return this.call<{ calendar: { email: string }; event: CalendarEvent | undefined; notifications?: string }>(
      CALENDAR_INTERNAL_PATHS.eventsUpdate,
      actorAssertion,
      input,
    );
  }

  deleteEvent(actorAssertion: string, input: { eventId: string; notify?: NotifyIntent }) {
    return this.call<{ calendar: { email: string }; deleted: string; notifications?: string }>(
      CALENDAR_INTERNAL_PATHS.eventsDelete,
      actorAssertion,
      input,
    );
  }

}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
      ? body.error
      : "the Google Calendar request was refused";
  } catch {
    return "the Google Calendar request was refused";
  }
}