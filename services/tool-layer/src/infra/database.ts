import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { verifyActorAssertion, type RelayActorContext } from "./actor-assertion.js";
import type { Project } from "../domain/permissions.js";
import { getShape, type Filter } from "../domain/shapes.js";
import {
  mergeCompany,
  mergePerson,
  normalizeDomains,
  normalizeLinkedIn,
  resolveCompany,
  resolvePerson,
  type EntityCandidate,
} from "../domain/entities.js";

type Client = SupabaseClient<any>;
type Env = Record<string, string | undefined>;

export interface TeammateMatch {
  email: string;
  display_name: string | null;
}

const ENTITY_TABLES: Record<string, string> = {
  companies: "companies",
  people: "people",
  events: "events",
};
const INTERNAL_ONLY_TABLES = new Set([
  "app.companies",
  "app.people",
]);

/** Columns the resolver needs to decide a merge. Kept in one place so a new
 *  mergeable field is not silently dropped from the candidate row. */
const COMPANY_CANDIDATE_COLUMNS =
  "id, name, domains, domain_key, linkedin_url, description, location, employee_count, " +
  "industry, vertical, technology, stage, company_type, domain_expertise, website, tags, " +
  "source, source_url, confidence, observed_at, classification, scope";
const PERSON_CANDIDATE_COLUMNS =
  "id, full_name, aliases, person_type, company_id, title, location, linkedin_url, bio, " +
  "education, links, tags, source, source_url, confidence, observed_at, classification, scope";

const MIN_ENTITY_CONFIDENCE = 0.6;

export interface EntityWriteResult {
  status: "created" | "merged" | "queued";
  id?: string;
  review_id?: string;
  matched_by?: string;
  row?: unknown;
}

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
  const isZoom =
    host === "zoom.us" ||
    host.endsWith(".zoom.us") ||
    host === "zoom.com" ||
    host.endsWith(".zoom.com");
  const markers = isZoom ? ["j", "wc", "s"] : ["meet", "meeting"];
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
  }

  async verifyRelayProject(): Promise<void> {
    const { error } = await this.client("relay").schema("app").from("companies").select("*").limit(0);
    supabaseError(error);
  }

  /** The authoritative mapping from a verified email to the canonical Supabase
   * user id: auth-table lookup, confirmed and non-deleted users only.
   * Membership is established by the Supabase sign-up hook; the optional
   * No caller-supplied domain list: the sign-up hook is the boundary.
   * Service-role only.
   * The single resolver the shared-mailbox flow uses to authenticate a
   * sender; an unknown email resolves to null, never a guess. */
  async memberByEmail(candidate: string): Promise<string | null> {
    const client = this.client("relay");
    const { data, error } = await client.schema("app").rpc("member_by_email", { candidate });
    supabaseError(error);
    return typeof data === "string" && data.length > 0 ? data : null;
  }

  /** Resolve a teammate's name or email to calendar-invitable addresses.
   * Confirmed, active accounts only; the SQL function is service-role-only and
   * returns nothing but email and display name. Ambiguous names return every
   * match so the agent can ask which person the user meant. */
  async searchMembers(candidate: string, maxRows = 20): Promise<TeammateMatch[]> {
    const client = this.client("relay");
    const { data, error } = await client.schema("app").rpc("search_members", {
      candidate,
      max_rows: maxRows,
    });
    supabaseError(error);
    if (!Array.isArray(data)) return [];
    return data.flatMap((row: unknown): TeammateMatch[] => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const record = row as Record<string, unknown>;
      if (typeof record.email !== "string" || record.email.length === 0) return [];
      return [{
        email: record.email,
        display_name: typeof record.display_name === "string" && record.display_name.length > 0
          ? record.display_name
          : null,
      }];
    });
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
    const order = getShape(table).order;
    if (order) query = query.order(order.column, { ascending: order.ascending });

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
    actor?: { userId: string | null },
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
    if (table === "app.companies" || table === "app.people") {
      const { data: existing, error: existingError } = await client.schema("app").from(relation!)
        .select("scope, owner_user_id, classification").eq(where.column, where.value).maybeSingle();
      supabaseError(existingError);
      if (!existing) throw new Error("update must match exactly one row");
      const row = existing as { scope?: string; owner_user_id?: string | null; classification?: string };
      if (row.classification !== "internal") throw new Error("not allowed to update this entity");
      if (row.scope !== "org" && row.owner_user_id !== (actor?.userId ?? null)) {
        throw new Error("not allowed to update this entity");
      }
    }
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
  async resolveMeetingId(ref: string): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error("meeting_id is required");
    const client = this.client("relay");
    if (UUID_RE.test(trimmed)) {
      const byId = await client.schema("transcripts").from("meetings")
        .select("id").eq("id", trimmed).maybeSingle();
      supabaseError(byId.error);
      if (byId.data?.id) return byId.data.id as string;
      const byInstance = await client.schema("transcripts").from("meetings")
        .select("id").eq("instance_id", trimmed).maybeSingle();
      supabaseError(byInstance.error);
      if (byInstance.data?.id) return byInstance.data.id as string;
      throw new Error(`meeting not found: ${trimmed}`);
    }
    const nativeId = nativeIdFromMeetingRef(trimmed);
    if (!nativeId) throw new Error(`could not parse a meeting reference from "${trimmed}"`);
    const { data, error } = await client.schema("transcripts").from("meetings")
      .select("id").eq("native_id", nativeId)
      .order("created_at", { ascending: false }).limit(1);
    supabaseError(error);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row?.id) throw new Error(`no capture found for meeting ${nativeId}`);
    return row.id as string;
  }

  /**
   * Unified Relay search: companies, people, and meeting snippets in one
   * ranking. Served by app.search_relay.
   */
  async searchRelay(query: string, kinds: string[] | null, limit: number): Promise<unknown[]> {
    const trimmed = query.trim().slice(0, 512);
    if (!trimmed) throw new Error("query is required");
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const client = this.client("relay");
    const { data, error } = await client.schema("app")
      .rpc("search_relay", {
        q: trimmed,
        kinds: kinds && kinds.length > 0 ? kinds : null,
        max_rows: safeLimit,
      });
    supabaseError(error);
    return data ?? [];
  }

  /** Entity inserts land in the shared directory through this resolver: an
   *  exact identity match merges, no match inserts, and an ambiguous match
   *  goes to app.entity_review instead of guessing. */
  async upsertEntity(table: "app.companies" | "app.people", values: Record<string, unknown>): Promise<EntityWriteResult> {
    return table === "app.companies" ? this.upsertCompany(values) : this.upsertPerson(values);
  }

  private async upsertCompany(values: Record<string, unknown>): Promise<EntityWriteResult> {
    const client = this.client("relay");
    const confidence = typeof values.confidence === "number" ? values.confidence : null;
    if (confidence !== null && confidence < MIN_ENTITY_CONFIDENCE) {
      return this.queueEntityReview("company", values, [], "confidence below 0.6");
    }
    const domains = normalizeDomains(values.domains);
    const primary = domains[0] ?? null;
    const name = typeof values.name === "string" ? values.name : "";
    const candidates = await this.companyCandidates(client, domains, primary, name);
    const decision = resolveCompany(candidates, values);
    if (decision.action === "review") {
      return this.queueEntityReview("company", values, decision.candidates, decision.reason);
    }
    if (decision.action === "merge") {
      return this.mergeCompanyInto(client, decision.candidate, values, decision.matchedBy);
    }
    const { data, error } = await client.schema("app").from("companies").insert(values).select("*").single();
    if (error?.code === "23505") {
      const existing = primary ? await this.companyByDomainKey(client, primary) : null;
      if (existing) {
        const decision = resolveCompany([existing], values);
        if (decision.action === "merge") return this.mergeCompanyInto(client, existing, values, decision.matchedBy);
        return this.queueEntityReview(
          "company",
          values,
          [existing],
          decision.action === "review" ? decision.reason : "concurrent primary-domain insert",
        );
      }
    }
    supabaseError(error);
    return { status: "created", id: (data as { id: string }).id, row: data };
  }

  private async upsertPerson(values: Record<string, unknown>): Promise<EntityWriteResult> {
    const client = this.client("relay");
    const confidence = typeof values.confidence === "number" ? values.confidence : null;
    if (confidence !== null && confidence < MIN_ENTITY_CONFIDENCE) {
      return this.queueEntityReview("person", values, [], "confidence below 0.6");
    }
    const name = typeof values.full_name === "string" ? values.full_name : "";
    const companyId = typeof values.company_id === "string" ? values.company_id : null;
    const linkedin = normalizeLinkedIn(values.linkedin_url);
    const candidates = await this.personCandidates(client, name, companyId, linkedin);
    const decision = resolvePerson(candidates, values);
    if (decision.action === "review") {
      return this.queueEntityReview("person", values, decision.candidates, decision.reason);
    }
    if (decision.action === "merge") {
      return this.mergePersonInto(client, decision.candidate, values, decision.matchedBy);
    }
    const { data, error } = await client.schema("app").from("people").insert(values).select("*").single();
    supabaseError(error);
    return { status: "created", id: (data as { id: string }).id, row: data };
  }

  private async companyCandidates(client: Client, domains: string[], primary: string | null, name: string): Promise<EntityCandidate[]> {
    const rows: EntityCandidate[] = [];
    const run = async (query: any) => {
      const { data, error } = await query;
      supabaseError(error);
      if (Array.isArray(data)) rows.push(...(data as EntityCandidate[]));
    };
    if (domains.length > 0) {
      await run(client.schema("app").from("companies").select(COMPANY_CANDIDATE_COLUMNS).overlaps("domains", domains).limit(10));
    }
    if (primary) {
      await run(client.schema("app").from("companies").select(COMPANY_CANDIDATE_COLUMNS).eq("domain_key", primary).limit(10));
    }
    if (name.trim()) {
      await run(client.schema("app").from("companies").select(COMPANY_CANDIDATE_COLUMNS).ilike("name", likeEscape(name.trim())).limit(10));
    }
    return uniqueCandidates(rows);
  }

  private async personCandidates(client: Client, name: string, companyId: string | null, linkedin: string | null): Promise<EntityCandidate[]> {
    const rows: EntityCandidate[] = [];
    const run = async (query: any) => {
      const { data, error } = await query;
      supabaseError(error);
      if (Array.isArray(data)) rows.push(...(data as EntityCandidate[]));
    };
    if (name.trim()) {
      await run(client.schema("app").from("people").select(PERSON_CANDIDATE_COLUMNS).ilike("full_name", likeEscape(name.trim())).limit(10));
    }
    if (linkedin) {
      await run(client.schema("app").from("people").select(PERSON_CANDIDATE_COLUMNS).ilike("linkedin_url", `%${likeEscape(linkedin)}%`).limit(10));
    }
    if (name.trim() && companyId) {
      await run(client.schema("app").from("people").select(PERSON_CANDIDATE_COLUMNS).eq("company_id", companyId).ilike("full_name", likeEscape(name.trim())).limit(10));
    }
    return uniqueCandidates(rows);
  }

  private async companyByDomainKey(client: Client, primary: string): Promise<EntityCandidate | null> {
    const { data, error } = await client.schema("app").from("companies").select(COMPANY_CANDIDATE_COLUMNS).eq("domain_key", primary).limit(2);
    supabaseError(error);
    const rows = Array.isArray(data) ? data as EntityCandidate[] : [];
    return rows.length === 1 ? rows[0]! : null;
  }

  private async mergeCompanyInto(client: Client, existing: EntityCandidate, incoming: Record<string, unknown>, matchedBy: string): Promise<EntityWriteResult> {
    const now = new Date().toISOString();
    const { values, conflicts } = mergeCompany(existing, incoming, now);
    if (conflicts.length > 0) {
      return this.queueEntityReview("company", incoming, [existing], conflicts.join("; "));
    }
    const { data, error } = await client.schema("app").from("companies")
      .update({ ...values, updated_at: now }).eq("id", existing.id).select("*").single();
    supabaseError(error);
    return { status: "merged", id: existing.id, matched_by: matchedBy, row: data };
  }

  private async mergePersonInto(client: Client, existing: EntityCandidate, incoming: Record<string, unknown>, matchedBy: string): Promise<EntityWriteResult> {
    const now = new Date().toISOString();
    const { values, conflicts } = mergePerson(existing, incoming, now);
    if (conflicts.length > 0) {
      return this.queueEntityReview("person", incoming, [existing], conflicts.join("; "));
    }
    const { data, error } = await client.schema("app").from("people")
      .update({ ...values, updated_at: now }).eq("id", existing.id).select("*").single();
    supabaseError(error);
    return { status: "merged", id: existing.id, matched_by: matchedBy, row: data };
  }

  private async queueEntityReview(kind: "company" | "person", incoming: Record<string, unknown>, candidates: EntityCandidate[], reason: string): Promise<EntityWriteResult> {
    const { data, error } = await this.client("relay").schema("app").from("entity_review").insert({
      kind,
      incoming,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name ?? candidate.full_name ?? null,
        domains: candidate.domains ?? null,
        linkedin_url: candidate.linkedin_url ?? null,
        company_id: candidate.company_id ?? null,
      })),
      reason,
      source_url: typeof incoming.source_url === "string" ? incoming.source_url : null,
      actor_user: typeof incoming.actor_user === "string" ? incoming.actor_user : null,
      actor_agent: typeof incoming.actor_agent === "string" ? incoming.actor_agent : null,
    }).select("id").single();
    supabaseError(error);
    return { status: "queued", review_id: (data as { id: string }).id };
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
    tableName?: string | null;
    operation?: "insert" | "update" | null;
    rowId?: string | null;
  }): Promise<void> {
    const { error } = await this.client("relay").schema("logs").from("tool_calls").insert({
      user_id: input.userId,
      agent: input.agent,
      tool: input.tool,
      args_hash: input.argsHash,
      ms: input.ms,
      error: input.error,
      table_name: input.tableName ?? null,
      operation: input.operation ?? null,
      row_id: input.rowId ?? null,
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

function uniqueCandidates(rows: EntityCandidate[]): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
