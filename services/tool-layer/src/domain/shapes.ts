import type { Agent } from "./permissions.js";

export type Requirement = {
  f: string;
  r: "nonempty" | "url" | "number" | "uuid" | "uuid[]" | "jsonb";
};

export type Shape = {
  writable: readonly string[];
  serverSet: readonly string[];
  filterable: readonly string[];
  require: readonly Requirement[];
  valueEnums?: Readonly<Record<string, readonly string[]>>;
  updateKey?: string;
};

export const SHAPES: Record<string, Shape> = {
  "app.companies": {
    writable: [
      "name", "domains", "description", "source", "source_url", "observed_at",
      "confidence", "external_source", "external_source_id",
    ],
    serverSet: [
      "actor_user", "actor_agent", "classification", "embedding", "created_at",
      "updated_at", "captured_at",
    ],
    filterable: ["name", "domains", "classification", "observed_at", "actor_user"],
    require: [
      { f: "name", r: "nonempty" },
      { f: "source_url", r: "url" },
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
    ],
    filterable: ["full_name", "person_type", "company_id", "observed_at", "actor_user"],
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
    ],
    serverSet: [
      "actor_user", "actor_agent", "classification", "created_at", "updated_at", "captured_at",
    ],
    filterable: ["title", "type", "company_id", "tags", "occurred_at", "actor_user"],
    valueEnums: { type: ["meeting", "gathering", "fundraising", "talk", "demo_day"] },
    require: [
      { f: "title", r: "nonempty" },
      { f: "occurred_at", r: "nonempty" },
      { f: "attendee_ids", r: "uuid[]" },
      { f: "source_url", r: "url" },
    ],
  },
  // Conversation history is read-only for agents: a conversation belongs to the
  // authenticated user, and the trusted server path writes it.
  "history.conversations": {
    writable: [],
    serverSet: ["user_id", "agent", "created_at", "updated_at"],
    filterable: ["id", "agent", "status", "created_at", "updated_at"],
    valueEnums: {
      agent: ["scout", "mercury", "curator"],
      status: ["idle", "running", "failed"],
    },
    require: [],
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
export type ActorContext = { agent: Agent; userId: string | null };
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
    validateValueEnums(shape, values);
    if (shape.serverSet.includes("actor_user")) values.actor_user = actor.userId;
    if (shape.serverSet.includes("actor_agent")) values.actor_agent = actor.agent;
    if (shape.serverSet.includes("classification")) values.classification = "internal";
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
  if (shape.serverSet.includes("created_at")) values.created_at = now;
  if (shape.serverSet.includes("updated_at")) values.updated_at = now;
  if (shape.serverSet.includes("captured_at")) values.captured_at = now;
  if (shape.serverSet.includes("embedding")) values.embedding = null;

  return { values };
}
