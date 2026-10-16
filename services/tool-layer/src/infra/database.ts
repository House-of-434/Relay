import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { verifyActorAssertion, type RelayActorContext } from "./actor-assertion.js";
import type { Project } from "../domain/permissions.js";
import type { Filter } from "../domain/shapes.js";

type Client = SupabaseClient<any>;
type Env = Record<string, string | undefined>;

const ENTITY_TABLES: Record<string, string> = {
  companies: "companies",
  people: "people",
  events: "events",
};
const INTERNAL_ONLY_TABLES = new Set([
  "app.companies",
  "app.people",
  "app.events",
]);

function entityTypeForTable(table: string): string | undefined {
  const entityType = table.startsWith("app.") ? table.slice("app.".length) : "";
  return entityType in ENTITY_TABLES ? entityType : undefined;
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Required Tool Layer setting ${key} is missing`);
  return value;
}

function assertProjectUrl(urlText: string, projectRef: string, env: Env): string {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Supabase project URL is invalid");
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLoopback && url.protocol === "http:" && env.NODE_ENV !== "production")) {
    throw new Error("Supabase project URL must use HTTPS (HTTP is allowed only for local development)");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Supabase project URL must not include credentials, query parameters, or a path");
  }
  if (!isLoopback && url.hostname !== `${projectRef}.supabase.co`) {
    throw new Error("Supabase project URL does not match its configured project ref");
  }
  return url.toString().replace(/\/$/, "");
}

function makeClient(url: string, key: string): Client {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  }) as Client;
}

function supabaseError(error: { code?: string; message?: string } | null): never | void {
  if (error) throw new Error(`Database request failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which resolved capture to read: the exact one normally, but when it produced
 *  no segments and the room has a readable sibling capture, the sibling — a
 *  denied, never-admitted, or silent attempt must not mask the room's real
 *  recording. Pure, for tests. */
export function chooseMeetingCapture(
  exact: { id: string; segment_count: number; native_id: string | null },
  sibling: { id: string } | null,
): string {
  return exact.segment_count === 0 && exact.native_id !== null && sibling !== null ? sibling.id : exact.id;
}

/** Model-facing read projection for transcripts.meetings, used by relay_read.
 * Emails, invitee lists, audio_path and internal timestamps stay out of agent
 * reads: they are plumbing, not notes. `error` (the end reason) stays here so
 * a debugging relay_read can see why a capture stopped, but the curated
 * transcript read below omits it so it is never narrated as a finding. */
export const MEETING_READ_COLUMNS =
  "id, platform, instance_id, native_id, title, scheduled_start, scheduled_end, " +
  "actual_start, actual_end, status, error, segment_count, duration_seconds, " +
  "organizer_user_id, creator_user_id";

/** Curated projection for get_meeting_transcript: what an agent needs to name
 * the meeting (title, or the native room code) and read it, and nothing it
 * would narrate as plumbing (no internal UUIDs, error/end-reason, emails, or
 * internal timestamps). */
export const MEETING_TRANSCRIPT_COLUMNS =
  "platform, native_id, title, status, segment_count, duration_seconds, " +
  "actual_start, actual_end";

/** Provider meeting code (native_id) from a meeting reference that is a URL or
 * a bare code — null when neither parses. Mirrors the capture worker's
 * nativeIdFor so the URL an agent just joined resolves to the stored row:
 * Meet uses the first path segment, Zoom the id after /j|/wc|/s, Teams after
 * /meet, and anything else the last non-empty path segment. */
export function nativeIdFromMeetingRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("://")) return trimmed.slice(0, 128); // already a code
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter(Boolean);
  if (host === "meet.google.com") return seg[0] ?? null;
  const markers = host === "zoom.us" || host.endsWith(".zoom.us") ? ["j", "wc", "s"] : ["meet"];
  const i = seg.findIndex((s) => markers.includes(s));
  return i >= 0 && seg[i + 1] ? seg[i + 1]! : null;
}

/**
 * Distinguishable ingest conflict: the meetings_live_once partial unique
 * index fired (two calendar events pointing at the same live Meet link).
 * The route maps this to 409 live_meeting_conflict so the worker writes a
 * skipped row instead of treating it as an ingest error.
 */
export class IngestConflictError extends Error {
  readonly instanceId: string;
  constructor(instanceId: string) {
    super(`live meeting conflict for ${shortInstanceId(instanceId)}`);
    this.name = "IngestConflictError";
    this.instanceId = instanceId;
  }
}

function shortInstanceId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function applyFilters(query: any, filters: Filter[]): any {
  for (const filter of filters) {
    switch (filter.operator) {
      case "eq": query = query.eq(filter.column, filter.value); break;
      case "gte": query = query.gte(filter.column, filter.value); break;
      case "lte": query = query.lte(filter.column, filter.value); break;
      case "in": query = query.in(filter.column, filter.value); break;
      case "like": query = query.like(filter.column, filter.value); break;
    }
  }
  return query;
}

export class RelayDatabase {
  private readonly clients = new Map<Project, Client>();

  constructor(private readonly env: Env = process.env) {
    const relayUrl = assertProjectUrl(
      required(env, "RELAY_DB_URL"),
      required(env, "RELAY_DB_PROJECT_REF"),
      env,
    );
    const relayKey = required(env, "RELAY_DB_SERVICE_ROLE_KEY");
    this.clients.set("relay", makeClient(relayUrl, relayKey));

    const newsletterKeys = ["NEWSLETTER_READONLY_URL", "NEWSLETTER_READONLY_KEY", "NEWSLETTER_READONLY_PROJECT_REF"];
    const newsletterConfigured = newsletterKeys.filter((key) => Boolean(env[key]?.trim()));
    if (newsletterConfigured.length !== 0 && newsletterConfigured.length !== newsletterKeys.length) {
      throw new Error("NEWSLETTER_READONLY_URL, NEWSLETTER_READONLY_KEY, and NEWSLETTER_READONLY_PROJECT_REF must be configured together");
    }
    if (newsletterConfigured.length === newsletterKeys.length) {
      const newsletterUrl = assertProjectUrl(
        required(env, "NEWSLETTER_READONLY_URL"),
        required(env, "NEWSLETTER_READONLY_PROJECT_REF"),
        env,
      );
      this.clients.set("newsletter", makeClient(newsletterUrl, required(env, "NEWSLETTER_READONLY_KEY")));
    }
  }

  async verifyRelayProject(): Promise<void> {
    const { error } = await this.client("relay").schema("app").from("companies").select("*").limit(0);
    supabaseError(error);
  }

  client(project: Project): Client {
    const client = this.clients.get(project);
    if (!client) {
      throw new Error(`${project} database credentials are not configured; refusing the request`);
    }
    return client;
  }

  /** The single auth route into the database boundary: a signed harness actor
   * assertion. The owner key is the Supabase UUID; the sign-in domain
   * allow-list is enforced where the session was issued, never here. */
  authenticateActorAssertion(value: string): RelayActorContext {
    return verifyActorAssertion(value, this.env.RELAY_TOOL_ACTOR_SECRET);
  }

  async read(project: Project, table: string, filters: Filter[], limit: number, userId: string | null): Promise<unknown[]> {
    const client = this.client(project);
    if (project === "relay" && table === "history.conversations") {
      return this.readOwnConversations(client, filters, limit, userId);
    }

    const [schema, relation] = table.split(".");
    const columns = table === "transcripts.meetings" ? MEETING_READ_COLUMNS : "*";
    let query: any = client.schema(schema!).from(relation!).select(columns).limit(limit);

    // service_role bypasses Postgres RLS, so preserve the agent classification
    // ceiling explicitly in the Tool Layer.
    if (INTERNAL_ONLY_TABLES.has(table)) query = query.eq("classification", "internal");
    query = applyFilters(query, filters);

    const { data, error } = await query;
    supabaseError(error);
    return data ?? [];
  }

  /**
   * Conversation history is private to its owner. The Tool Layer connects with
   * service_role, which bypasses Postgres RLS, so the owner scope is enforced
   * here: no actor means no conversation history at all.
   */
  private async readOwnConversations(
    client: Client,
    filters: Filter[],
    limit: number,
    userId: string | null,
  ): Promise<unknown[]> {
    if (userId === null) throw new Error("conversation history requires an authenticated actor");
    let query: any = client.schema("history").from("conversations").select("*").limit(limit);
    query = query.eq("user_id", userId);
    query = applyFilters(query, filters);
    const { data, error } = await query;
    supabaseError(error);
    return data ?? [];
  }

  async write(
    project: Project,
    table: string,
    operation: "insert" | "update",
    values: Record<string, unknown>,
    where?: { column: string; value: string },
  ): Promise<unknown> {
    const [schema, relation] = table.split(".");
    const client = this.client(project);
    if (operation === "insert") {
      const { data, error } = await client.schema(schema!).from(relation!).insert(values).select("*");
      supabaseError(error);
      const entityType = entityTypeForTable(table);
      if (entityType) {
        const inserted = Array.isArray(data) ? data[0] : null;
        if (!inserted || typeof inserted.id !== "string") throw new Error("insert did not return the created entity");
        return this.readEntity(client, entityType, inserted.id);
      }
      return data;
    }

    if (!where) throw new Error("where is required for update");
    const { data, error } = await client.schema(schema!).from(relation!)
      .update(values)
      .eq(where.column, where.value)
      .select("*");
    supabaseError(error);
    if (!data || data.length !== 1) {
      throw new Error("update must match exactly one row");
    }
    const entityType = entityTypeForTable(table);
    if (entityType) return this.readEntity(client, entityType, data[0]!.id);
    return data[0];
  }

  /**
   * Capture-ingest upsert for one meeting row, keyed by instance_id.
   * Segments may be empty: status-only transitions (joining,
   * awaiting_admission, failed) all happen before any segments exist.
   */
  async ingestMeeting(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof values.instance_id !== "string" || values.instance_id.length === 0) {
      throw new Error("ingest meeting requires instance_id");
    }
    const client = this.client("relay");
    const row: Record<string, unknown> = { ...values };
    delete row.owner_user_id;
    if (row.actor_agent == null && row.actor_user == null) {
      const { data, error } = await client.schema("app").rpc("scribe_service_actor_id");
      supabaseError(error);
      if (typeof data === "string" && data.length > 0) {
        row.actor_agent = "scribe";
        row.actor_user = data;
      }
    }
    if (row.organizer_user_id == null && typeof row.organizer_email === "string" && row.organizer_email.length > 0) {
      const { data, error } = await client.schema("app").rpc("member_by_email", { candidate: row.organizer_email });
      supabaseError(error);
      if (typeof data === "string") row.organizer_user_id = data;
    }
    if (row.creator_user_id == null && typeof row.invited_by === "string" && row.invited_by.length > 0) {
      const { data, error } = await client.schema("app").rpc("member_by_email", { candidate: row.invited_by });
      supabaseError(error);
      if (typeof data === "string") row.creator_user_id = data;
    }
    const { data, error } = await client.schema("transcripts").from("meetings")
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "instance_id" })
      .select("*");
    if (error?.code === "23505") throw new IngestConflictError(values.instance_id);
    supabaseError(error);
    const saved = Array.isArray(data) ? data[0] : null;
    if (!saved || typeof saved.id !== "string") throw new Error("ingest meeting did not return the meeting row");
    return saved as Record<string, unknown>;
  }

  /**
   * Capture-ingest upsert for segments, keyed by (meeting_id, segment_key).
   * Callers chunk large batches; this method upserts exactly what it gets.
   */
  async ingestSegments(meetingId: string, segments: Record<string, unknown>[]): Promise<number> {
    if (segments.length === 0) return 0;
    for (const segment of segments) {
      if (typeof segment.segment_key !== "string" || typeof segment.text !== "string" ||
          typeof segment.start_seconds !== "number" || typeof segment.end_seconds !== "number") {
        throw new Error("ingest segment requires segment_key, text, start_seconds, end_seconds");
      }
    }
    const client = this.client("relay");
    const { error } = await client.schema("transcripts").from("meeting_segments")
      .upsert(
        segments.map((segment) => ({ ...segment, meeting_id: meetingId })),
        { onConflict: "meeting_id,segment_key" },
      );
    if (error?.code === "23505") throw new IngestConflictError(meetingId);
    supabaseError(error);
    return segments.length;
  }

  /**
   * Finalize every non-terminal meeting row. Called by a freshly-booted
   * capture worker (the only writer, and it owns zero sessions at boot): a row
   * still live at boot is a previous generation's orphan that would otherwise
   * hold the meetings_live_once slot and block the room forever. Rows with any
   * segment become `partial` (an interrupted capture), the rest `failed`;
   * actual_end is left to the reaper's wall clock via the error reason rather
   * than a fabricated end time.
   */
  async sweepOrphanedMeetings(reason: string): Promise<{ partial: number; failed: number }> {
    const live = ["joining", "awaiting_admission", "active"];
    const updatedAt = new Date().toISOString();
    const client = this.client("relay");
    const withSegments = await client.schema("transcripts").from("meetings")
      .update({ status: "partial", error: reason, updated_at: updatedAt })
      .in("status", live).gt("segment_count", 0).select("id");
    supabaseError(withSegments.error);
    const empty = await client.schema("transcripts").from("meetings")
      .update({ status: "failed", error: reason, updated_at: updatedAt })
      .in("status", live).eq("segment_count", 0).select("id");
    supabaseError(empty.error);
    return {
      partial: Array.isArray(withSegments.data) ? withSegments.data.length : 0,
      failed: Array.isArray(empty.data) ? empty.data.length : 0,
    };
  }

  /**
   * Ordered, paged transcript read for agents. Segments come back ordered by
   * start_seconds; complete is false while the meeting is still live, so
   * readers can mark in-progress transcripts incomplete.
   */
  async getMeetingTranscript(meetingId: string, offset: number, limit: number): Promise<{
    meeting: Record<string, unknown>;
    segments: Record<string, unknown>[];
    total_length: number;
    complete: boolean;
  }> {
    if (!meetingId) throw new Error("meeting_id is required");
    const resolvedId = await this.resolveMeetingId(meetingId);
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const client = this.client("relay");
    const { data: meeting, error: meetingError } = await client.schema("transcripts").from("meetings")
      .select(MEETING_TRANSCRIPT_COLUMNS).eq("id", resolvedId).maybeSingle();
    supabaseError(meetingError);
    if (!meeting) throw new Error("meeting not found");
    // Project only what a reader needs. select("*") would also ship id,
    // segment_key, speaker_key, channel, language, is_final, created_at and the
    // generated search_vector (a long word-position string) — pure token bloat.
    const { data: segments, error: segmentsError } = await client.schema("transcripts").from("meeting_segments")
      .select("speaker, start_seconds, end_seconds, text, confidence")
      .eq("meeting_id", resolvedId)
      .order("start_seconds", { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);
    supabaseError(segmentsError);
    const { count, error: countError } = await client.schema("transcripts").from("meeting_segments")
      .select("*", { count: "exact", head: true }).eq("meeting_id", resolvedId);
    supabaseError(countError);
    // The projection is a runtime string, so PostgREST's generated types fall
    // back to GenericStringError; the row is the selected columns at runtime.
    const row = meeting as unknown as Record<string, unknown>;
    return {
      meeting: row,
      segments: (segments ?? []) as Record<string, unknown>[],
      total_length: count ?? 0,
      complete: row.status === "completed",
    };
  }

  /**
   * Resolve a meeting reference — a meeting id (uuid), a capture instance_id,
   * a provider URL, or a room code — to the meeting row's id. This is what
   * lets an agent read "the meeting I just joined" in one call, instead of
   * having to list rows and chain ids. UUIDs match id then instance_id;
   * anything else matches native_id, newest first (a room code reused over
   * time resolves to the latest capture).
   */
  /**
   * One meeting row for a column match, newest first — optionally only rows
   * that produced segments, and only at/after a time floor.
   */
  private async findMeeting(
    client: any,
    where: { column: "id" | "instance_id" | "native_id"; value: string },
    options: { readableOnly?: boolean; createdAfter?: string } = {},
  ): Promise<{ id: string; native_id: string | null; segment_count: number; created_at: string } | null> {
    let query: any = client.schema("transcripts").from("meetings")
      .select("id, native_id, segment_count, created_at")
      .eq(where.column, where.value)
      .order("created_at", { ascending: false })
      .limit(1);
    if (options.readableOnly) query = query.gt("segment_count", 0);
    if (options.createdAfter) query = query.gte("created_at", options.createdAfter);
    const { data, error } = await query;
    supabaseError(error);
    const row = (Array.isArray(data) ? data[0] : null) as
      | { id?: string; native_id?: string | null; segment_count?: number; created_at?: string }
      | null;
    if (!row?.id) return null;
    return { id: row.id, native_id: row.native_id ?? null, segment_count: row.segment_count ?? 0, created_at: row.created_at ?? "" };
  }

  /**
   * Resolve a meeting reference — a meeting id (uuid), a capture instance_id,
   * a provider URL, or a room code — to the transcript row to read.
   *
   * A room reference means the room's recording: its latest capture that
   * produced content, else its latest attempt. A uuid resolves to that exact
   * capture, EXCEPT that a capture which produced nothing (denied, never
   * admitted, silent) must not mask the room's real recording — so it falls
   * back to a readable sibling for the same room created near it. The 24h
   * bound covers retries (which land minutes apart) without letting a stale
   * occurrence of a reused room code leak in.
   */
  async resolveMeetingId(ref: string): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error("meeting_id is required");
    const client = this.client("relay");

    if (UUID_RE.test(trimmed)) {
      const exact = await this.findMeeting(client, { column: "id", value: trimmed })
        ?? await this.findMeeting(client, { column: "instance_id", value: trimmed });
      if (!exact) throw new Error(`meeting not found: ${trimmed}`);
      let sibling: { id: string } | null = null;
      if (exact.segment_count === 0 && exact.native_id) {
        const parsed = Date.parse(exact.created_at);
        const createdAfter = Number.isFinite(parsed)
          ? new Date(parsed - 24 * 60 * 60 * 1000).toISOString()
          : undefined;
        sibling = await this.findMeeting(
          client,
          { column: "native_id", value: exact.native_id },
          { readableOnly: true, createdAfter },
        );
      }
      return chooseMeetingCapture(exact, sibling);
    }

    const nativeId = nativeIdFromMeetingRef(trimmed);
    if (!nativeId) throw new Error(`could not parse a meeting reference from "${trimmed}"`);
    const readable = await this.findMeeting(client, { column: "native_id", value: nativeId }, { readableOnly: true });
    if (readable) return readable.id;
    const latest = await this.findMeeting(client, { column: "native_id", value: nativeId });
    if (!latest) throw new Error(`no capture found for meeting ${nativeId}`);
    return latest.id;
  }

  /**
   * Ranked full-text search over transcript segments, joined back to the
   * meeting. Served by the transcripts.search_meetings SQL function.
   */
  async searchMeetings(query: string, limit: number): Promise<unknown[]> {
    const trimmed = query.trim().slice(0, 512);
    if (!trimmed) throw new Error("query is required");
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const client = this.client("relay");
    const { data, error } = await client.schema("transcripts")
      .rpc("search_meetings", { q: trimmed, lim: safeLimit });
    supabaseError(error);
    return data ?? [];
  }

  /**
   * Operational tool-call log. Unlike `write`, this is not an agent-facing
   * table: logs.* is denied to agents (permissions.ts) and only the service
   * role writes it. Callers swallow a failure so a logging outage never
   * fails the tool call; this rejects only on a real insert error.
   */
  async logToolCall(input: {
    userId: string | null;
    agent: string;
    tool: string;
    argsHash: string;
    ms: number;
    error: string | null;
  }): Promise<void> {
    const { error } = await this.client("relay").schema("logs").from("tool_calls").insert({
      user_id: input.userId,
      agent: input.agent,
      tool: input.tool,
      args_hash: input.argsHash,
      ms: input.ms,
      error: input.error,
    });
    supabaseError(error);
  }

  private async readEntity(client: Client, entityType: string, entityId: string): Promise<unknown> {
    const entityTable = ENTITY_TABLES[entityType];
    if (!entityTable) throw new Error("unsupported entity type");
    const { data, error } = await client.schema("app").from(entityTable)
      .select("*")
      .eq("id", entityId)
      .single();
    supabaseError(error);
    return data;
  }
}
