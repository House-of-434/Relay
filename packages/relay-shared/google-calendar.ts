export interface GoogleCalendarAccountSnapshot {
  id: string;
  email: string;
}

export interface GoogleCalendarEventTime {
  dateTime?: string;
  date?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  accountId: string;
  accountEmail: string;
  eventId: string;
  title: string;
  description?: string;
  htmlLink?: string;
  status: "confirmed" | "tentative" | "cancelled";
  start: GoogleCalendarEventTime;
  end: GoogleCalendarEventTime;
  timeZone?: string;
  allDay: boolean;
}

export interface GoogleCalendarEventError {
  accountId: string;
  email: string;
  error: string;
}

export interface GoogleCalendarEventsResponse {
  configured: boolean;
  connected: boolean;
  events: GoogleCalendarEvent[];
  errors: GoogleCalendarEventError[];
}

export const GOOGLE_CALENDAR_CONNECTIONS_CHANGED_EVENT = "relay:google-calendar-connections-changed";

export function googleCalendarSnapshotKey(accounts: readonly GoogleCalendarAccountSnapshot[]): string {
  return JSON.stringify(accounts
    .map(({ id, email }) => ({ id, email }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.email.localeCompare(right.email)));
}
