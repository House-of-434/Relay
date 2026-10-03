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

/** Resolve project and authorize from the immutable agent route, never tool arguments. */
export function authorize(agent: Agent, operation: Operation, table: string): Project {
  if (explicitlyDenied(table, operation)) {
    throw new Error(`${operation} access denied for ${table}`);
  }

  const matches = PERMISSIONS[agent][operation]
    .filter((entry) => entry.endsWith(`/${table}`))
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

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}
