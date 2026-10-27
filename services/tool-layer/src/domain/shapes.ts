import type { Agent } from "./permissions.js";

export type Requirement = {
  f: string;
  r: "nonempty" | "url" | "number" | "uuid" | "uuid[]" | "jsonb";
};

export type Shape = {
  writable: readonly string[];
  serverSet: readonly string[];
  filterable: readonly string[];
  /** Enforced on insert: the field must be present and valid. */
  require: readonly Requirement[];
  /** Validated whenever the field is supplied on insert or update, but never
   * required. Keeps bounds on an optional column without demanding it. */
  validate?: readonly Requirement[];
  valueEnums?: Readonly<Record<string, readonly string[]>>;
  updateKey?: string;
  /** Default read order. Applied by relay_read before the limit, so
   * `limit: 1` returns the newest/oldest row without a separate sort tool. */
  order?: { column: string; ascending: boolean };
};

export const SHAPES: Record<string, Shape> = {
  "app.companies": {
    writable: [
      "name", "domains", "description", "source", "source_url", "observed_at",
      "confidence", "external_source", "external_source_id",
      // Notion "Running Deals" mirror (migration 0009). The select/status
      // fields stay plain text: Notion options evolve and are written as given.
      "status", "stage", "technology", "vertical", "industry", "deal_source",
      "founder_name", "founder_email", "founder_linkedin", "founder_age",
      "website", "has_lead", "domain_expertise", "raise_amount",
      "pre_money_valuation", "founding_date", "submission_date",
      "target_close_date", "deck_url", "data_room_url", "notion_page_id",
      "notion_url",
    ],
    serverSet: [
      "actor_user", "actor_agent", "classification", "embedding", "created_at",
      "updated_at", "captured_at", "owner_user_id", "scope",
    ],
    filterable: [
      "name", "domains", "classification", "observed_at", "actor_user",
      "owner_user_id", "scope", "notion_page_id", "status", "stage",
      "technology", "industry",
    ],
    require: [
      { f: "name", r: "nonempty" },
      { f: "source_url", r: "url" },
    ],
    // Optional on insert: a mirrored board row is data, not an agent
    // observation, so it need not carry a score — but any score supplied must
    // be in range.
    validate: [
      { f: "confidence", r: "number" },
    ],
  },
  "app.people": {
    writable: [
      "full_name", "aliases", "person_type", "company_id", "source", "source_url",
      "observed_at", "confidence", "external_source", "external_source_id",
    ],
    serverSet: [
      "actor_user", "actor_agent", "classification", "created_at", "updated_at", "captured_at",
      "owner_user_id", "scope",
    ],
    filterable: ["full_name", "person_type", "company_id", "observed_at", "actor_user", "owner_user_id", "scope"],
    valueEnums: { person_type: ["founder", "investor", "partner", "other"] },
    require: [
      { f: "full_name", r: "nonempty" },
      { f: "company_id", r: "uuid" },
      { f: "confidence", r: "number" },
      { f: "source_url", r: "url" },
    ],
  },
  "app.events": {
    writable: [
      "type", "title", "summary", "occurred_at", "company_id", "tags", "attendee_ids",
      "investor_names", "round", "amount", "source", "source_url", "observed_at",
      "confidence", "external_source", "external_source_id",
      // Event Content Tracker fields (migration 0011). hosted stays plain text:
      // the tracker's options evolve, so no app-side enum rejects a valid value.
      "hosted", "city", "speakers", "media_url", "cover_image_url", "notes",
    ],
    serverSet: [
      "actor_user", "actor_agent", "classification", "created_at", "updated_at", "captured_at",
      "owner_user_id", "scope",
    ],
    filterable: [
      "title", "type", "company_id", "tags", "occurred_at", "hosted", "city",
      "actor_user", "owner_user_id", "scope",
    ],
    valueEnums: { type: ["meeting", "gathering", "fundraising", "talk", "demo_day"] },
    require: [
      { f: "title", r: "nonempty" },
      { f: "occurred_at", r: "nonempty" },
      { f: "source_url", r: "url" },
    ],
    validate: [
      { f: "attendee_ids", r: "uuid[]" },
      { f: "media_url", r: "url" },
      { f: "cover_image_url", r: "url" },
    ],
  },
  // Conversation history is read-only for agents: a conversation belongs to the
  // authenticated user, and the trusted server path writes it.
  "history.conversations": {
    writable: [],
    serverSet: ["user_id", "bot_id", "thread_id", "agent", "created_at", "updated_at"],
    filterable: ["id", "agent", "status", "created_at", "updated_at"],
    valueEnums: {
      agent: ["scout", "mercury", "curator"],
      status: ["idle", "running", "failed"],
    },
    require: [],
  },
  // Meeting transcripts are read-only for agents: the capture pipeline writes
  // them through the ingest route, never through relay_write. Segments stay
  // unregistered — relay_read can't order/page transcript text, so they are
  // served only by the bespoke get_meeting_transcript/search_meetings tools.
  "transcripts.meetings": {
    writable: [],
    serverSet: [
      "platform", "instance_id", "calendar_event_id", "native_id", "title",
      "scheduled_start", "scheduled_end", "actual_start", "actual_end",
      "status", "error", "organizer_email", "organizer_user_id",
      "creator_user_id", "invited_by", "invitees",
      "audio_path", "segment_count", "duration_seconds",
      "created_at", "updated_at",
    ],
    filterable: [
      "id", "instance_id", "native_id", "platform", "status", "scheduled_start",
      "organizer_user_id", "calendar_event_id",
    ],
    valueEnums: {
      platform: ["google_meet", "zoom", "teams"],
      status: ["joining", "awaiting_admission", "active", "completed", "partial", "failed", "skipped"],
    },
    require: [],
  },
  // Membership applications live in Relay's public schema. They are read-only
  // for agents; the site form writes them, and the newest application is the
  // person who most recently joined the pipeline.
  "public.applications": {
    writable: [],
    serverSet: [
      "id", "name", "email", "linkedin", "location", "role", "entity", "website",
      "story", "looking_for", "brings", "learn", "referrer", "role_details",
      "attribution", "whatsapp_number", "whatsapp_opt_in", "created_at",
    ],
    filterable: [
      "name", "email", "role", "entity", "location", "referrer",
      "whatsapp_opt_in", "created_at",
    ],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  // The other public intake forms share the same read-only, newest-first
  // contract. They are written by the public site, never by an agent.
  "public.invitation_requests": {
    writable: [],
    serverSet: [
      "id", "name", "email", "linkedin", "location", "building", "interest", "created_at",
    ],
    filterable: ["name", "email", "location", "interest", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  "public.host_applications": {
    writable: [],
    serverSet: [
      "id", "name", "email", "linkedin", "city", "background", "communities",
      "events_hosted", "event_idea", "created_at",
    ],
    filterable: ["name", "email", "city", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  "public.partner_inquiries": {
    writable: [],
    serverSet: [
      "id", "company", "contact_name", "email", "city", "partnership_type",
      "budget", "notes", "created_at",
    ],
    filterable: ["company", "contact_name", "email", "city", "partnership_type", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  "public.newsletter_subscribers": {
    writable: [],
    serverSet: ["id", "name", "email", "created_at"],
    filterable: ["name", "email", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  "public.suppressed_emails": {
    writable: [],
    serverSet: ["id", "email", "reason", "metadata", "created_at"],
    filterable: ["email", "reason", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
  "public.email_send_log": {
    writable: [],
    serverSet: [
      "id", "message_id", "template_name", "recipient_email", "status",
      "error_message", "metadata", "created_at",
    ],
    filterable: ["message_id", "template_name", "recipient_email", "status", "created_at"],
    require: [],
    order: { column: "created_at", ascending: false },
  },
};

const FILTER_OPERATORS = ["_gte", "_lte", "_in", "_like"] as const;
export type FilterOperator = "eq" | "gte" | "lte" | "in" | "like";
export type Filter = { column: string; operator: FilterOperator; value: unknown };

export function getShape(table: string): Shape {
  const shape = SHAPES[table];
  if (!shape) throw new Error(`No column shape is configured for ${table}`);
  return shape;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

export function validateFilters(table: string, filters: Record<string, unknown>): Filter[] {
  const shape = getShape(table);
  const entries = Object.entries(filters);
  if (entries.length > 20) throw new Error("filters may contain at most 20 entries");

  return entries.map(([key, value]) => {
    const suffix = FILTER_OPERATORS.find((candidate) => key.endsWith(candidate));
    const column = suffix ? key.slice(0, -suffix.length) : key;
    const operator = suffix ? suffix.slice(1) as FilterOperator : "eq";
    if (!shape.filterable.includes(column)) throw new Error(`Column ${column} is not filterable on ${table}`);

    if (operator === "in") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(isScalar)) {
        throw new Error(`${key} must be an array of 1–100 scalar values`);
      }
    } else if (operator === "like") {
      if (typeof value !== "string" || value.length > 256) {
        throw new Error(`${key} must be a string of at most 256 characters`);
      }
    } else if (operator === "gte" || operator === "lte") {
      if (!(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
        throw new Error(`${key} must be a string or finite number`);
      }
    } else if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) {
      throw new Error(`${key} must be a scalar or scalar array`);
    }

    if (column === "actor_user" || column === "created_by") {
      const values = operator === "in" ? value as unknown[] : [value];
      if (!values.every((entry) => typeof entry === "string" && UUID.test(entry))) {
        throw new Error(`${column} filters must contain UUIDs`);
      }
    }

    return { column, operator, value };
  });
}

export type WriteOperation = "insert" | "update";
export type ActorContext = {
  agent: Agent;
  userId: string | null;
  /** The bot and thread the turn ran as, from the verified actor assertion. */
  botId?: string | null;
  threadId?: string | null;
};
export type PreparedWrite = { values: Record<string, unknown>; where?: { column: string; value: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASSIFICATION_CEILING: Record<Agent, "internal"> = {
  scout: "internal",
  mercury: "internal",
  curator: "internal",
};
const CLASSIFICATION_RANK = { internal: 0, confidential: 1, restricted: 2 } as const;

function validateRequirement(field: string, rule: Requirement["r"], value: unknown): void {
  switch (rule) {
    case "nonempty":
      if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a nonempty string`);
      return;
    case "url": {
      if (typeof value !== "string") throw new Error(`${field} must be an http(s) URL`);
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        throw new Error(`${field} must be an http(s) URL`);
      }
      return;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${field} must be a finite number between 0 and 1`);
      }
      return;
    case "uuid":
      if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field} must be a UUID`);
      return;
    case "uuid[]":
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && UUID.test(entry))) {
        throw new Error(`${field} must be an array of UUIDs`);
      }
      return;
    case "jsonb":
      if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        throw new Error(`${field} must be JSON serializable`);
      }
      try {
        JSON.stringify(value);
      } catch {
        throw new Error(`${field} must be JSON serializable`);
      }
  }
}

/** Validate a shape's optional rules only when the field is actually supplied,
 * on insert or update. `require` gates presence; `validate` gates the value. */
function validateSupplied(shape: Shape, values: Record<string, unknown>): void {
  for (const { f, r } of shape.validate ?? []) {
    if (f in values) validateRequirement(f, r, values[f]);
  }
}

function validateValueEnums(shape: Shape, data: Record<string, unknown>): void {
  for (const [field, allowed] of Object.entries(shape.valueEnums ?? {})) {
    if (!(field in data)) continue;
    const value = data[field];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((entry) => typeof entry === "string" && allowed.includes(entry))) {
      throw new Error(`${field} contains a value outside its allowed set`);
    }
  }
}

export function prepareWrite(
  table: string,
  operation: WriteOperation,
  input: unknown,
  where: unknown,
  actor: ActorContext,
  now = new Date().toISOString(),
): PreparedWrite {
  const shape = getShape(table);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("data must be an object");
  const data = input as Record<string, unknown>;
  if (actor.userId !== null && !UUID.test(actor.userId)) throw new Error("actor user id must be a UUID");
  const allowed = new Set([...shape.writable, ...shape.serverSet]);
  const unknown = Object.keys(data).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`Unknown column(s) for ${table}: ${unknown.join(", ")}`);
  if ("classification" in data) {
    const ceiling = CLASSIFICATION_CEILING[actor.agent];
    const attempted = data.classification;
    if (typeof attempted !== "string" || !(attempted in CLASSIFICATION_RANK) ||
        CLASSIFICATION_RANK[attempted as keyof typeof CLASSIFICATION_RANK] > CLASSIFICATION_RANK[ceiling]) {
      throw new Error(`classification exceeds the ${actor.agent} ceiling`);
    }
  }
  if (table.startsWith("app.") && !actor.userId) {
    throw new Error("entity writes require authenticated actor context");
  }

  const values: Record<string, unknown> = {};
  for (const field of shape.writable) {
    if (field in data) values[field] = data[field];
  }

  if (operation === "insert") {
    for (const { f, r } of shape.require) {
      validateRequirement(f, r, values[f]);
    }
    validateSupplied(shape, values);
  } else {
    const updateKey = shape.updateKey ?? "id";
    if (!where || typeof where !== "object" || Array.isArray(where)) {
      throw new Error("where must identify exactly one row for update");
    }
    const whereObject = where as Record<string, unknown>;
    if (Object.keys(whereObject).length !== 1 || !(updateKey in whereObject)) {
      throw new Error(`where must contain only ${updateKey} for update`);
    }
    const whereValue = whereObject[updateKey];
    if (updateKey === "id" && (typeof whereValue !== "string" || !UUID.test(whereValue))) {
      throw new Error("where.id must be a UUID");
    }
    if (updateKey === "thread_id" && (typeof whereValue !== "string" || !whereValue.trim())) {
      throw new Error("where.thread_id must be nonempty");
    }
    if (Object.keys(values).length === 0) throw new Error("data must contain at least one writable column");
    for (const { f, r } of shape.require) {
      if (f in values) validateRequirement(f, r, values[f]);
    }
    validateSupplied(shape, values);
    validateValueEnums(shape, values);
    if (shape.serverSet.includes("actor_user")) values.actor_user = actor.userId;
    if (shape.serverSet.includes("actor_agent")) values.actor_agent = actor.agent;
    if (shape.serverSet.includes("classification")) values.classification = "internal";
    if (shape.serverSet.includes("owner_user_id")) values.owner_user_id = actor.userId;
    if (shape.serverSet.includes("scope")) values.scope = "private";
    if (shape.serverSet.includes("bot_id")) values.bot_id = actor.botId ?? null;
    if (shape.serverSet.includes("thread_id")) values.thread_id = actor.threadId ?? null;
    if (shape.serverSet.includes("updated_at")) values.updated_at = now;
    return { values, where: { column: updateKey, value: whereValue as string } };
  }

  validateValueEnums(shape, values);
  for (const { f, r } of shape.require) validateRequirement(f, r, values[f]);

  // Model-supplied values for serverSet columns are deliberately discarded.
  if (shape.serverSet.includes("actor_user")) values.actor_user = actor.userId;
  if (shape.serverSet.includes("actor_agent")) values.actor_agent = actor.agent;
  if (shape.serverSet.includes("classification")) values.classification = "internal";
  if (shape.serverSet.includes("created_by")) values.created_by = actor.userId;
  if (shape.serverSet.includes("owner_user_id")) values.owner_user_id = actor.userId;
  if (shape.serverSet.includes("scope")) values.scope = "private";
  if (shape.serverSet.includes("bot_id")) values.bot_id = actor.botId ?? null;
  if (shape.serverSet.includes("thread_id")) values.thread_id = actor.threadId ?? null;
  if (shape.serverSet.includes("created_at")) values.created_at = now;
  if (shape.serverSet.includes("updated_at")) values.updated_at = now;
  if (shape.serverSet.includes("captured_at")) values.captured_at = now;
  if (shape.serverSet.includes("embedding")) values.embedding = null;

  return { values };
}
