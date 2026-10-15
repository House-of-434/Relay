import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RelayDatabase } from "../infra/database.js";
import { authorizeScribe, type Agent } from "../domain/permissions.js";
import { nativeIdForUrl } from "../infra/scribe.js";

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export type CapturePhase = "requested" | "in_meeting" | "completed" | "failed";

export interface CaptureStatusView {
  instance_id: string | null;
  meeting_id: string | null;
  meeting_url: string | null;
  phase: CapturePhase;
  joined: boolean;
  transcript: {
    ready: boolean;
    meeting_id: string | null;
    title: string | null;
    segment_count: number;
    status: string | null;
  };
  note: string;
}

/**
 * Honest capture state from a transcript row (or its absence). A meeting row
 * is written at admission, so presence alone proves the join happened;
 * absence means still queued/joining — never claimed as joined. Pure:
 * every branch is unit-tested below without a database.
 */
export function summarizeCapture(
  meeting: Record<string, unknown> | null,
  query: { instance_id?: string; meeting_url?: string },
): CaptureStatusView {
  const base = {
    instance_id: typeof meeting?.instance_id === "string" ? meeting.instance_id as string : query.instance_id ?? null,
    meeting_url: query.meeting_url ?? null,
  };
  const emptyTranscript = { ready: false, meeting_id: null, title: null, segment_count: 0, status: null };
  if (!meeting) {
    return {
      ...base,
      meeting_id: null,
      phase: "requested",
      joined: false,
      transcript: emptyTranscript,
      note: "no capture record yet — the request may still be queued or joining; check again in half a minute. If this persists, the join never armed.",
    };
  }
  const meetingId = typeof meeting.id === "string" ? meeting.id : null;
  const title = typeof meeting.title === "string" ? meeting.title : null;
  const status = typeof meeting.status === "string" ? meeting.status : null;
  const segments = typeof meeting.segment_count === "number" && Number.isFinite(meeting.segment_count)
    ? Math.max(0, Math.floor(meeting.segment_count))
    : 0;
  const transcript = { ready: segments > 0, meeting_id: meetingId, title, segment_count: segments, status };
  if (status === "failed" || status === "skipped") {
    const error = typeof meeting.error === "string" && meeting.error.length > 0
      ? meeting.error.slice(0, 200)
      : "the capture failed";
    return {
      ...base, meeting_id: meetingId, phase: "failed", joined: segments > 0,
      transcript,
      note: segments > 0
        ? `the capture failed but kept ${segments} segments: ${error}`
        : `the capture failed before recording: ${error}`,
    };
  }
  if (status === "completed" || status === "partial") {
    return {
      ...base, meeting_id: meetingId, phase: "completed", joined: true,
      transcript,
      note: segments > 0
        ? "the transcript is ready — read it with get_meeting_transcript."
        : "the capture finished but recorded no segments.",
    };
  }
  return {
    ...base, meeting_id: meetingId, phase: "in_meeting", joined: true,
    transcript,
    note: segments > 0
      ? "still recording; this is the transcript so far (complete is false)."
      : "the bot has joined and is recording; no segments yet.",
  };
}

/**
 * Capture-status tool. Answers "did Scribe join?" and "is it transcribed?"
 * from the transcript rows — the same rows search_meetings and
 * get_meeting_transcript read — so follow-ups like "summarize that meeting"
 * resolve to a concrete meeting_id. Mercury-only, like the join tool.
 */
export function registerScribeStatusTools(
  server: McpServer,
  agent: Agent,
  database: RelayDatabase,
  userId: string | null,
): void {
  server.registerTool(
    "scribe_capture_status",
    {
      description: "Check whether a Scribe capture joined and whether its transcript is ready. Pass the instance_id from scribe_join_meeting, or the meeting_url you asked to join. Returns queued (no record yet — still joining, check again soon), in_meeting (recording now, with segments so far), completed (transcript ready — read it with get_meeting_transcript), or failed. Use this to confirm a join instead of claiming it joined, and to locate the transcript before summarizing a meeting.",
      inputSchema: {
        instance_id: z.string().min(1).max(64).optional(),
        meeting_url: z.string().min(1).max(2048).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instance_id, meeting_url }) => {
      try {
        if (!userId) throw new Error("authenticated actor required");
        authorizeScribe(agent, "join");
        if (!instance_id && !meeting_url) {
          throw new Error("provide instance_id or meeting_url");
        }
        if (instance_id) {
          const rows = await database.findMeetingsByInstanceIds([instance_id]);
          return { content: [{ type: "text", text: JSON.stringify({ captures: [summarizeCapture(rows[0] ?? null, { instance_id })] }) }] };
        }
        const native = nativeIdForUrl(meeting_url!);
        if (!native) throw new Error("meeting_url is not a supported provider link");
        const rows = await database.findMeetingsByNativeIds([native.nativeId]);
        const ordered = rows
          .slice()
          .sort((a, b) => String(b.actual_start ?? "").localeCompare(String(a.actual_start ?? "")))
          .slice(0, 5);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              captures: ordered.length > 0
                ? ordered.map((row) => summarizeCapture(row, { meeting_url }))
                : [summarizeCapture(null, { meeting_url })],
            }),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
