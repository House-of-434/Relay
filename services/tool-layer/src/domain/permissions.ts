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
      "relay/transcripts.meetings",
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
      "relay/transcripts.meetings",
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
      "relay/transcripts.meetings",
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

/** Meeting-capture requests: Mercury only. Asking Scribe to join a meeting
 * is a visible external action (the join is announced in the meeting), so it
 * stays with the agent that owns external comms — the same agents that may
 * not even see Gmail or calendar tools must not see this one either. */
export type ScribeCapability = "join" | "stop";

export const SCRIBE_PERMISSIONS: Record<Agent, readonly ScribeCapability[]> = {
  scout: [],
  mercury: ["join", "stop"],
  curator: [],
};

export function authorizeScribe(agent: Agent, capability: ScribeCapability): void {
  if (!SCRIBE_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`${capability} access denied for ${agent}`);
  }
}

/**
 * Capture-ingest writes: the only path that may touch transcript tables.
 * There is deliberately no agent in the signature — no agent route may ever
 * reach these tables, not even through a future grant. The loopback ingest
 * route is the sole caller, and it authenticates with the shared ingest
 * capability before reaching this allowlist.
 */
export type IngestOperation = "insert" | "update" | "upsert";

const INGEST_WRITES: Record<string, readonly IngestOperation[]> = {
  "transcripts.meetings": ["insert", "update", "upsert"],
  "transcripts.meeting_segments": ["insert", "update", "upsert"],
};

export function authorizeIngest(table: string, operation: IngestOperation): void {
  if (!(INGEST_WRITES[table] ?? []).includes(operation)) {
    throw new Error(`${operation} access denied for ${table}`);
  }
}

/** Web-fetch capability: read one page as clean text. Same simple model as
 * search — no per-user state, granted per agent. Only Scout researches. */
export type FetchCapability = "fetch";

export const FETCH_PERMISSIONS: Record<Agent, readonly FetchCapability[]> = {
  scout: ["fetch"],
  mercury: [],
  curator: [],
};

export function authorizeFetch(agent: Agent, capability: FetchCapability): void {
  if (!FETCH_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`${capability} access denied for ${agent}`);
  }
}

/** arXiv research capability: public paper search and retrieval. Only Scout
 * researches, and every connector capability is granted per agent, never per
 * request or per user. */
export type ArxivCapability = "search" | "get";

export const ARXIV_PERMISSIONS: Record<Agent, readonly ArxivCapability[]> = {
  scout: ["search", "get"],
  mercury: [],
  curator: [],
};

export function authorizeArxiv(agent: Agent, capability: ArxivCapability): void {
  if (!ARXIV_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`arxiv ${capability} access denied for ${agent}`);
  }
}

/** SEC EDGAR research capability: CIK resolution, filing search, company facts,
 * full-text filing search, reading a filing document, XBRL frames, and
 * cross-company fact comparison. */
export type SecCapability = "resolve" | "filings" | "facts" | "text" | "filing" | "frames" | "compare";

export const SEC_PERMISSIONS: Record<Agent, readonly SecCapability[]> = {
  scout: ["resolve", "filings", "facts", "text", "filing", "frames", "compare"],
  mercury: [],
  curator: [],
};

export function authorizeSec(agent: Agent, capability: SecCapability): void {
  if (!SEC_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`sec ${capability} access denied for ${agent}`);
  }
}

/** GitHub research capability: repository, file, issue, and release reads.
 * Public vs private is decided by the actor's own installation at the BFF,
 * never by the tool arguments; there is one read capability per agent. */
export type GithubCapability = "read";

export const GITHUB_PERMISSIONS: Record<Agent, readonly GithubCapability[]> = {
  scout: ["read"],
  mercury: [],
  curator: [],
};

export function authorizeGithub(agent: Agent, capability: GithubCapability): void {
  if (!GITHUB_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`github ${capability} access denied for ${agent}`);
  }
}

/** Notion workspace capability: reads are shared research, writes stay with
 * the agent that owns inbox-driven dealflow. Private vs shared is decided by
 * the actor's own workspace connection at the BFF, never by tool arguments. */
export type NotionCapability = "read" | "write";

export const NOTION_PERMISSIONS: Record<Agent, readonly NotionCapability[]> = {
  scout: ["read"],
  mercury: ["read", "write"],
  curator: ["read"],
};

export function authorizeNotion(agent: Agent, capability: NotionCapability): void {
  if (!NOTION_PERMISSIONS[agent].includes(capability)) {
    throw new Error(`notion ${capability} access denied for ${agent}`);
  }
}

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}
