import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RelayDatabase } from "../infra/database.js";
import { authorize, type Agent } from "../domain/permissions.js";

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function mmss(startSeconds: unknown): string {
  const total = typeof startSeconds === "number" && Number.isFinite(startSeconds) ? Math.max(0, Math.floor(startSeconds)) : 0;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Meeting-transcript tools. All three agents get the same pair: an ordered,
 * paged transcript read and a ranked full-text search. Listing meetings is
 * plain relay_read on the read-only transcripts.meetings shape — no bespoke
 * tool. Every handler re-checks the transcripts read grant, so removing the
 * grant revokes the tools even where they are still listed.
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
      description: "Read one captured meeting's transcript in time order, paged. meeting_id accepts any meeting reference and is resolved for you: the meeting URL (e.g. https://meet.google.com/abc-defg-hij), the room code, the instance_id returned by scribe_join_meeting, or the meeting UUID. Use this to get notes for a meeting that was just joined or recorded; do NOT use search_meetings to find a specific recent meeting. Returns the meeting row, the ordered segments for the requested window, total_length, and complete. A single call is never the whole transcript when total_length exceeds the page — call it again with a higher offset until complete is true. complete is false while the meeting is still live; treat those rows as incomplete.",
      inputSchema: {
        meeting_id: z.string().min(1).max(64),
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
    "search_meetings",
    {
      description: "Full-text search across all captured meeting transcripts. Returns ranked snippets with speaker and mm:ss timestamp, plus start_seconds and the meeting id. To read the minutes around a hit, call get_meeting_transcript with that meeting id and page to the segment near start_seconds.",
      inputSchema: {
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        authorize(agent, "read", "transcripts.meetings");
        const rows = await database.searchMeetings(query, limit ?? 20);
        const shaped = (Array.isArray(rows) ? rows : []).map((row) => {
          const entry = row as Record<string, unknown>;
          return { ...entry, at: mmss(entry.start_seconds) };
        });
        return { content: [{ type: "text", text: JSON.stringify(shaped) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
