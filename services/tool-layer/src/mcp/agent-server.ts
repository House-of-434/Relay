import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { RelayDatabase } from "../infra/database.js";
import { authorize, authorizeCalendar, authorizeGmail, BROWSER_PERMISSIONS, CALENDAR_PERMISSIONS, GMAIL_PERMISSIONS, SEARCH_PERMISSIONS, type Agent } from "../domain/permissions.js";
import { RelayGmailClient } from "../infra/gmail.js";
import { RelayCalendarClient } from "../infra/calendar.js";
import { getShape, prepareWrite, validateFilters } from "../domain/shapes.js";
import { EVENT_CHANGES_INPUT, EVENT_DRAFT_INPUT, NOTIFY_INPUT, READ_INPUT, WRITE_INPUT } from "./schemas.js";
import { registerBrowserTools, type BladeBrowserContext } from "./browser-server.js";
import { registerSearchTools, type SearchToolContext } from "./search-server.js";

export interface RelayGmailContext {
  client: RelayGmailClient;
  actorAssertion: string;
}

export interface RelayCalendarContext {
  client: RelayCalendarClient;
  actorAssertion: string;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createAgentMcpServer(
  agent: Agent,
  userId: string | null,
  database: RelayDatabase,
  gmail: RelayGmailContext | undefined,
  calendar: RelayCalendarContext | undefined,
  browser?: BladeBrowserContext | undefined,
  search?: SearchToolContext | undefined,
): McpServer {
  const server = new McpServer({ name: "relay-tools", version: "0.1.0" });

  server.registerTool(
    "relay_read",
    {
      description: "Read rows from a table explicitly permitted for this Relay agent. Filters are parameterized; only shaped columns and eq, _gte, _lte, _in, and _like are supported.",
      inputSchema: READ_INPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ table, filters, limit }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        const project = authorize(agent, "read", table);
        const shape = getShape(table);
        if (!shape.filterable) throw new Error(`No filter shape is configured for ${table}`);
        const validatedFilters = validateFilters(table, filters ?? {});
        const rows = await database.read(project, table, validatedFilters, Math.min(limit ?? 50, 100), userId);
        return { content: [{ type: "text", text: JSON.stringify(rows) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "relay_write",
    {
      description: "Insert or update one row in a table explicitly permitted for this Relay agent. Column shapes are enforced; updates must target one row.",
      inputSchema: WRITE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ table, operation, data, where }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        const project = authorize(agent, "write", table);
        const prepared = prepareWrite(table, operation, data, where, { agent, userId });
        const result = await database.write(project, table, operation, prepared.values, prepared.where);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // Visibility matches authorization: an agent with no Gmail or calendar
  // capability must not even see those tools offered.
  //
  // The research browser additionally requires an authenticated user: without
  // one there is no workspace the daemon could safely be scoped to.
  if (browser && userId && BROWSER_PERMISSIONS[agent].length > 0) {
    registerBrowserTools(server, agent, browser);
  }

  // Search carries no per-user state (unlike the browser workspace), so the
  // call itself needs no userId — but listing it still requires an
  // authenticated actor. No user-scoped data required does not mean no
  // caller identity required. Visibility still matches authorization.
  if (search && userId && SEARCH_PERMISSIONS[agent].length > 0) {
    registerSearchTools(server, agent, search);
  }

  if (gmail && GMAIL_PERMISSIONS[agent].length > 0) {
    const gmailContext: RelayGmailContext = gmail;

    server.registerTool(
      "gmail_search",
      {
        description: "Search the connected Gmail mailbox with Gmail query syntax, for example \"from:ana newer_than:7d\". Read-only.",
        inputSchema: {
          query: z.string().min(1).max(512),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, maxResults }) => {
        try {
          authorizeGmail(agent, "search");
          const result = await gmailContext.client.searchMessages(gmailContext.actorAssertion, { query, maxResults });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "gmail_read",
      {
        description: "Read one message from the connected Gmail mailbox by id returned from gmail_search. Read-only.",
        inputSchema: { messageId: z.string().min(1).max(512) },
        annotations: { readOnlyHint: true },
      },
      async ({ messageId }) => {
        try {
          authorizeGmail(agent, "read");
          const result = await gmailContext.client.getMessage(gmailContext.actorAssertion, { messageId });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "gmail_send_email",
      {
        description: "Send an email from the connected Gmail mailbox. Do not call this yourself: use propose_email_send so the owner confirms the exact recipients, subject, and body first. This tool executes only the confirmed action.",
        inputSchema: {
          to: z.array(z.string().min(3).max(320)).min(1).max(20),
          cc: z.array(z.string().min(3).max(320)).max(20).optional(),
          bcc: z.array(z.string().min(3).max(320)).max(20).optional(),
          subject: z.string().max(250),
          body: z.string().max(20_000),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ to, cc, bcc, subject, body }) => {
        try {
          authorizeGmail(agent, "send");
          const result = await gmailContext.client.sendEmail(gmailContext.actorAssertion, { to, cc, bcc, subject, body });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (calendar && CALENDAR_PERMISSIONS[agent].length > 0) {
    const calendarContext: RelayCalendarContext = calendar;

    server.registerTool(
      "calendar_list_events",
      {
        description: "List events on the connected calendar between two RFC3339 timestamps. Read-only.",
        inputSchema: {
          timeMin: z.string().min(1).max(64),
          timeMax: z.string().min(1).max(64),
          maxResults: z.number().int().min(1).max(250).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ timeMin, timeMax, maxResults }) => {
        try {
          authorizeCalendar(agent, "read");
          const result = await calendarContext.client.listEvents(calendarContext.actorAssertion, { timeMin, timeMax, maxResults });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "calendar_create_event",
      {
        description: "Create an event on the connected calendar. Attendees are emailed invitations. Use this only for events nobody else is invited to; if the user wants guests invited, propose the invitation first so they can confirm it.",
        inputSchema: { ...EVENT_DRAFT_INPUT, notify: NOTIFY_INPUT.optional() },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ notify, ...draft }) => {
        try {
          authorizeCalendar(agent, "create");
          const result = await calendarContext.client.createEvent(calendarContext.actorAssertion, { ...draft, notify });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "calendar_update_event",
      {
        description: "Change an existing event by id. Pass only the fields that should change; anything you leave out stays as it is. Attendees are emailed about the change unless the user asked otherwise. To answer an invitation you received, change your own attendee entry's responseStatus — you can only change your own response, not someone else's.",
        inputSchema: {
          eventId: z.string().min(1).max(512),
          ...EVENT_CHANGES_INPUT,
          notify: NOTIFY_INPUT.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ eventId, notify, ...changes }) => {
        try {
          // Responding to someone else's invitation is a distinct grant: it
          // touches only the connected user's own seat at the table.
          const answering = changes.attendees?.some((entry) => entry.responseStatus !== undefined) ?? false;
          authorizeCalendar(agent, answering ? "respond" : "update");
          const result = await calendarContext.client.updateEvent(calendarContext.actorAssertion, { eventId, notify, ...changes });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "calendar_delete_event",
      {
        description: "Delete an event from the connected calendar by id. Attendees are emailed that it is cancelled. You can only cancel an event you organized; for an event you were invited to, change your own responseStatus instead. Run this when the user asked for the cancellation.",
        inputSchema: { eventId: z.string().min(1).max(512), notify: NOTIFY_INPUT.optional() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ eventId, notify }) => {
        try {
          authorizeCalendar(agent, "delete");
          const result = await calendarContext.client.deleteEvent(calendarContext.actorAssertion, { eventId, notify });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  return server;
}
