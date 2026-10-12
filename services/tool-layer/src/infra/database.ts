import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { verifyActorAssertion } from "./actor-assertion.js";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUserId(userId: string): void {
  if (!UUID.test(userId)) throw new Error("actor user id must be a UUID");
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

export interface ReadOptions {
  /** Validated exact column names; joined server-side into the select string. */
  select: string[];
  limit: number;
  /** Row offset under the forced order. Integer-only, so no query smuggling;
   * offset paging can skip/dup under concurrent inserts — acceptable for an
   * internal team tool; `total` + `nextOffset` make the window visible. */
  offset: number;
  /** Count-only: no rows cross the boundary at all. */
  head: boolean;
}

export interface ReadEnvelope {
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  order: readonly ["created_at desc", "id asc"];
  /** Absent (not empty) when head is true — the key itself must not exist. */
  rows?: unknown[];
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

  async authenticateUser(accessToken: string): Promise<string> {
    const { data, error } = await this.client("relay").auth.getUser(accessToken);
    if (error || !data.user?.id || !data.user.email) {
      throw new Error("user access token is invalid or its verified user is incomplete");
    }
    assertUserId(data.user.id);
    this.validateAllowedEmail(data.user.email);
    return data.user.id;
  }

  authenticateActorAssertion(value: string): string {
    const actor = verifyActorAssertion(value, this.env.RELAY_TOOL_ACTOR_SECRET);
    this.validateAllowedEmail(actor.email);
    return actor.userId;
  }

  validateAllowedEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("email metadata is invalid");
    }
    const allowedDomains = (this.env.RELAY_ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    const domain = email.split("@").at(-1);
    if (allowedDomains.length === 0 || !domain || !allowedDomains.includes(domain)) {
      throw new Error("authenticated email domain is not allowed by Relay");
    }
    return email;
  }

  async read(project: Project, table: string, filters: Filter[], options: ReadOptions, userId: string | null): Promise<ReadEnvelope> {
    const client = this.client(project);
    if (project === "relay" && table === "history.conversations") {
      return this.readOwnConversations(client, filters, options, userId);
    }

    // Schema comes from the normalized, validated table name only: authorize()
    // rejects anything that is not `schema.relation` in lowercase identifier
    // form, so this split cannot carry quoting, case tricks, or operators.
    const [schema, relation] = table.split(".");
    return this.runRead(client, schema!, relation!, table, filters, options);
  }

  private async runRead(
    client: Client,
    schema: string,
    relation: string,
    table: string,
    filters: Filter[],
    options: ReadOptions,
  ): Promise<ReadEnvelope> {
    // The select string is built here from validated exact column names —
    // never from caller-joined text — so embedding and casts cannot smuggle.
    // Head mode with no select still needs a target; "*" is safe there
    // because head:true returns a count with no rows at all.
    const selectList = options.select.length ? options.select.join(",") : "*";
    let query: any = client.schema(schema).from(relation).select(selectList, { count: "exact", head: options.head });

    // service_role bypasses Postgres RLS, so preserve the agent classification
    // ceiling explicitly in the Tool Layer.
    if (INTERNAL_ONLY_TABLES.has(table)) query = query.eq("classification", "internal");
    query = applyFilters(query, filters);
    // Deterministic order on every read: without a stable ORDER BY, offset
    // paging can skip or duplicate rows under concurrent inserts.
    query = query.order("created_at", { ascending: false }).order("id", { ascending: true });
    if (!options.head) query = query.range(options.offset, options.offset + options.limit - 1);

    const { data, error, count } = await query;
    supabaseError(error);
    const total = count ?? 0;
    const order = ["created_at desc", "id asc"] as const;
    if (options.head) {
      // No `rows` key at all — not an empty array — so a pure count provably
      // carries no row data.
      return { total, limit: options.limit, offset: options.offset, nextOffset: null, order };
    }
    const rows = data ?? [];
    const nextOffset = options.offset + rows.length < total ? options.offset + rows.length : null;
    return { rows, total, limit: options.limit, offset: options.offset, nextOffset, order };
  }

  /**
   * Conversation history is private to its owner. The Tool Layer connects with
   * service_role, which bypasses Postgres RLS, so the owner scope is enforced
   * here: no actor means no conversation history at all.
   */
  private async readOwnConversations(
    client: Client,
    filters: Filter[],
    options: ReadOptions,
    userId: string | null,
  ): Promise<ReadEnvelope> {
    if (userId === null) throw new Error("conversation history requires an authenticated actor");
    return this.runReadScoped(client, filters, options, userId);
  }

  private async runReadScoped(
    client: Client,
    filters: Filter[],
    options: ReadOptions,
    userId: string,
  ): Promise<ReadEnvelope> {
    const selectList = options.select.length ? options.select.join(",") : "*";
    let query: any = client.schema("history").from("conversations").select(selectList, { count: "exact", head: options.head });
    query = query.eq("user_id", userId);
    query = applyFilters(query, filters);
    query = query.order("created_at", { ascending: false }).order("id", { ascending: true });
    if (!options.head) query = query.range(options.offset, options.offset + options.limit - 1);
    const { data, error, count } = await query;
    supabaseError(error);
    const total = count ?? 0;
    const order = ["created_at desc", "id asc"] as const;
    if (options.head) {
      return { total, limit: options.limit, offset: options.offset, nextOffset: null, order };
    }
    const rows = data ?? [];
    const nextOffset = options.offset + rows.length < total ? options.offset + rows.length : null;
    return { rows, total, limit: options.limit, offset: options.offset, nextOffset, order };
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
    /** Read audit: filter KEYS only, never values — an `email eq` value is
     * PII and the keys are enough for review. */
    table?: string | null;
    columns?: string[] | null;
    filterKeys?: string[] | null;
    rowCount?: number | null;
    flagged?: boolean;
  }): Promise<void> {
    const { error } = await this.client("relay").schema("logs").from("tool_calls").insert({
      user_id: input.userId,
      agent: input.agent,
      tool: input.tool,
      args_hash: input.argsHash,
      ms: input.ms,
      error: input.error,
      table_name: input.table ?? null,
      columns: input.columns ?? null,
      filter_keys: input.filterKeys ?? null,
      row_count: input.rowCount ?? null,
      flagged: input.flagged ?? false,
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
