export const AGENTS = ["scout", "mercury", "curator"] as const;
export type Agent = (typeof AGENTS)[number];
export type Operation = "read" | "write";
export type Project = "relay" | "newsletter";

export const PERMISSIONS: Record<Agent, Record<Operation, readonly string[]>> = {
  scout: {
    read: [
      "relay/app.companies",
      "relay/app.people",
      "relay/app.events",
      "relay/history.conversations",
      "newsletter/public.invitation_requests",
    ],
    write: [
      "relay/app.companies",
      "relay/app.people",
      "relay/app.events",
    ],
  },
  mercury: {
    read: [
      "relay/app.companies",
      "relay/app.people",
      "relay/app.events",
      "relay/history.conversations",
      "newsletter/public.newsletter_subscribers",
      "newsletter/public.suppressed_emails",
      "newsletter/public.email_send_log",
      "newsletter/public.invitation_requests",
    ],
    write: [
      "relay/app.companies",
      "relay/app.people",
      "relay/app.events",
    ],
  },
  curator: {
    read: [
      "relay/app.companies",
      "relay/app.people",
      "relay/app.events",
      "relay/history.conversations",
    ],
    write: [],
  },
};

export const DENY_ALL = [
  "logs.*",
  "public.email_unsubscribe_tokens",
  "auth.*",
  "storage.*",
  "vault.*",
  "newsletter/public.*[write]",
] as const;

function explicitlyDenied(table: string, operation: Operation): boolean {
  if (
    table.startsWith("logs.") ||
    table.startsWith("auth.") ||
    table.startsWith("storage.") ||
    table.startsWith("vault.") ||
    table === "public.email_unsubscribe_tokens"
  ) {
    return true;
  }

  return operation === "write" && table.startsWith("public.");
}

const READABLE_SCHEMAS = new Set(["app", "history", "public"]);
const TABLE_PART = /^[a-z_][a-z0-9_]*$/;

/** Normalize a caller-supplied table name before any matching: trim,
 * strip surrounding quotes, require `schema.relation`, fold to lowercase
 * (Postgres folds unquoted identifiers), and reject anything else. The
 * normalized name is the only string that reaches authorization, the shape
 * registry, and the schema header — so `or=(...)`, mixed case, quoting, and
 * unqualified names cannot smuggle past the denylist or the allowlist. */
export function normalizeTable(input: unknown): string {
  if (typeof input !== "string") throw new Error("table must be a schema-qualified name");
  const text = input.trim();
  const parts = text.split(".");
  if (parts.length !== 2) throw new Error("table must be a schema-qualified name like app.companies");
  const normalized = parts.map((part) => part.trim().replace(/["']/g, "").toLowerCase());
  const [schema, relation] = normalized as [string, string];
  if (!schema || !relation || !TABLE_PART.test(schema) || !TABLE_PART.test(relation)) {
    throw new Error("table must be a schema-qualified name like app.companies");
  }
  return `${schema}.${relation}`;
}

/** Reads are default-allow for every agent (workspace team members, low
 * sensitivity): any shaped table outside the denylist is readable. Writes
 * stay per-agent via PERMISSIONS below — only reads are open. */
export function authorize(agent: Agent, operation: Operation, table: string): Project {
  const normalized = normalizeTable(table);
  if (explicitlyDenied(normalized, operation)) {
    throw new Error(`${operation} access denied for ${table}`);
  }

  if (operation === "read") {
    const schema = normalized.split(".")[0]!;
    if (!READABLE_SCHEMAS.has(schema)) {
      throw new Error(`${operation} access denied for ${table}`);
    }
    // The shape registry is the second gate: a routed-but-unshaped table
    // (e.g. public.<unlisted>) still fails at getShape/validate time.
    // Single Supabase project: everything readable lives on the relay client.
    return "relay";
  }

  const matches = PERMISSIONS[agent][operation]
    .filter((entry) => entry.endsWith(`/${normalized}`))
    .map((entry) => entry.slice(0, entry.indexOf("/")) as Project);

  if (matches.length !== 1) {
    throw new Error(`${operation} access denied for ${table}`);
  }

  return matches[0]!;
}

/** Gmail operations are granted per agent and per capability, never per request. */
// Gmail is search, read, and send behind a user confirmation. Drafts were
// removed: proposing the exact content and sending it on confirm needs no
// intermediate draft sitting in the mailbox.
export type GmailCapability = "search" | "read" | "send";

export const GMAIL_PERMISSIONS: Record<Agent, readonly GmailCapability[]> = {
  scout: [],
  mercury: ["search", "read", "send"],
  curator: [],
};

/**
 * Gmail is deliberately absent here: sending is not a capability Relay grants to
 * any agent, so it cannot be authorized even by a future agent entry.
 */
export function authorizeGmail(agent: Agent, capability: GmailCapability): void {
  if (!GMAIL_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`${capability} access denied for ${agent}`);
  }
}

/**
 * Calendar operations are granted per agent and per capability, never per
 * request. Writes are separated from reads so an agent can be given the
 * ability to see a calendar without being able to change it.
 */
export type CalendarCapability = "read" | "create" | "update" | "delete" | "respond";

export const CALENDAR_PERMISSIONS: Record<Agent, readonly CalendarCapability[]> = {
  scout: [],
  // Answering an invitation is a separate grant from editing an event: it only
  // ever changes the connected user's own response to someone else's meeting.
  mercury: ["read", "create", "update", "delete", "respond"],
  curator: [],
};

export function authorizeCalendar(agent: Agent, capability: CalendarCapability): void {
  if (!CALENDAR_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`calendar ${capability} access denied for ${agent}`);
  }
}

/** Research-browser operations are granted per agent, never per request.
 * Only Scout researches the open web; Mercury and Curator work from Relay
 * records, mail, and calendar. */
export type BrowserCapability = "open" | "read" | "extract";

export const BROWSER_PERMISSIONS: Record<Agent, readonly BrowserCapability[]> = {
  scout: ["open", "read", "extract"],
  mercury: [],
  curator: [],
};

export function authorizeBrowser(agent: Agent, capability: BrowserCapability): void {
  if (!BROWSER_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`${capability} access denied for ${agent}`);
  }
}

/** Web-search capability: discovery with no per-user state, granted per
 * agent like everything else. Only Scout researches the open web. */
export type SearchCapability = "search";

export const SEARCH_PERMISSIONS: Record<Agent, readonly SearchCapability[]> = {
  scout: ["search"],
  mercury: [],
  curator: [],
};

export function authorizeSearch(agent: Agent, capability: SearchCapability): void {
  if (!SEARCH_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`${capability} access denied for ${agent}`);
  }
}

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}
