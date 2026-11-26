import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RelayDatabase } from "../infra/database.js";
import { authorize, type Agent } from "../domain/permissions.js";

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const SEARCH_KIND_TABLE = {
  company: "app.companies",
  person: "app.people",
  meeting: "transcripts.meetings",
} as const;
const SEARCH_KINDS = ["company", "person", "meeting"] as const;

/**
 * Relay record tools. All three agents get the same pair: an ordered, paged
 * meeting transcript read and one unified search across companies, people, and
 * meetings. Listing meetings is plain relay_read on the read-only
 * transcripts.meetings shape — no bespoke tool. Every handler re-checks the
 * read grant for each kind, so removing a grant revokes the capability even
 * where the tool is still listed.
 */
export function registerTranscriptTools(
  server: McpServer,
  agent: Agent,
  database: RelayDatabase,
  userId: string | null,
): void {
  server.registerTool(
    "get_meeting_transcript",
    {
      description: "Read one captured meeting's transcript in time order, paged. `meeting_id` accepts the meeting link, the room code, or the meeting id and is resolved for you — use this, not search_relay, to find a specific recent meeting. Name the meeting in your reply by its title, or by the room code when there is no title; never quote internal ids. Turn it into notes: who spoke and what was covered, led by the meeting's length and speakers rather than segment counts or capture internals. Page by calling again with a higher offset until complete is true; complete is false while the meeting is still live, so treat those rows as in-progress.",
      inputSchema: {
        meeting_id: z.string().min(1).max(2048),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ meeting_id, offset, limit }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        authorize(agent, "read", "transcripts.meetings");
        const result = await database.getMeetingTranscript(meeting_id, offset ?? 0, limit ?? 50);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_relay",
    {
      description: "Search Relay's shared records in one query: companies, people, and captured meeting transcripts. Results are ranked and tagged by kind (company, person, meeting); a meeting snippet starts with its mm:ss offset. Use this before researching so known companies and people are reused and refreshed rather than rediscovered. Pass kinds to narrow the search, and call get_meeting_transcript with a meeting id to read around a hit.",
      inputSchema: {
        query: z.string().min(1).max(512),
        kinds: z.array(z.enum(SEARCH_KINDS)).min(1).max(3).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kinds, limit }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        const requested = kinds && kinds.length > 0 ? kinds : [...SEARCH_KINDS];
        for (const kind of requested) authorize(agent, "read", SEARCH_KIND_TABLE[kind]);
        const rows = await database.searchRelay(query, kinds && kinds.length > 0 ? [...kinds] : null, limit ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(rows) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
