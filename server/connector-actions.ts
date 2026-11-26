import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { newId } from "./contracts.ts";
import { relayToolOrigin } from "./relay-mcp.ts";

/**
 * User-confirmed calendar invites. The card the user sees is display-only: the
 * pending invite lives here, keyed by requestId, and the resolve path looks
 * it up instead of trusting anything on the wire. No wire payload was added
 * for this on purpose — the event id must never reach the
 * browser, where it could be substituted. Email sends keep no pending store
 * here; the agent shows the draft in chat and the tool-call log is the audit trail.
 */

/** A person may review an invitation for a while before confirming it. Like a
 * research proposal (24h), the pending action must outlive that review and the
 * server restarts that can happen in between. */
export const CONNECTOR_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_THREAD = 10;
const MAX_STORED = 1_000;
const STORE_VERSION = 1;
const MAX_EMAILS = 20;
const MAX_ADDRESS = 320;
const MAX_DISPLAY_ATTENDEES = 10;

const email = z.string().email().max(MAX_ADDRESS);
const eventTime = z.union([
  z.object({ dateTime: z.string().min(1).max(64), timeZone: z.string().min(1).max(64).optional() }).strict(),
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
]);

const calendarInviteSchema = z.object({
  summary: z.string().min(1).max(500),
  start: eventTime,
  end: eventTime,
  when: z.string().min(1).max(120),
  attendees: z.array(email).min(1).max(MAX_EMAILS),
  description: z.string().max(8_000).optional(),
  location: z.string().max(500).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  /** Add a Google Meet link to the event. Only when the person explicitly
   * asked for an interview, call, or remote/video meeting. */
  createMeet: z.boolean().optional(),
}).strict();

export interface CalendarInviteTarget {
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  when: string;
  attendees: string[];
  description?: string;
  location?: string;
  timeZone?: string;
  createMeet?: boolean;
}

export type ConnectorActionTarget = CalendarInviteTarget;

export interface PendingConnectorAction {
  requestId: string;
  target: ConnectorActionTarget;
  botId: string;
  threadId: string;
  createdAt: number;
}

export class ConnectorActionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ConnectorActionError";
    this.status = status;
  }
}

function attendeeNames(attendees: string[]): string {
  const shown = attendees.slice(0, MAX_DISPLAY_ATTENDEES);
  const rest = attendees.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

export function connectorActionDisplay(target: ConnectorActionTarget): {
  title: string;
  subtitle: string;
  detail: string;
} {
  const invite = target;
  const guests = invite.attendees.length === 1 ? "this attendee" : "all these attendees";
  const meet = invite.createMeet
    ? "\n\nA Google Meet link will be added to the event and included in the invitation."
    : "";
  return {
    title: "Confirm event and invitations",
    subtitle: `${invite.summary} · ${invite.when}`,
    detail: `Attendees (${invite.attendees.length}): ${attendeeNames(invite.attendees)}\n\nConfirming creates this on your primary calendar and Google emails invitations to ${guests}.${meet}`,
  };
}

/** One durable row, validated on load so a tampered or truncated file cannot
 * smuggle an arbitrary target into a confirmed tool call. */
function storedAction(raw: unknown): PendingConnectorAction | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const target = calendarInviteSchema.safeParse(row.target);
  if (!target.success) return undefined;
  if (typeof row.requestId !== "string" || row.requestId.length === 0) return undefined;
  if (typeof row.botId !== "string" || row.botId.length === 0) return undefined;
  if (typeof row.threadId !== "string" || row.threadId.length === 0) return undefined;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return undefined;
  return { requestId: row.requestId, target: target.data, botId: row.botId, threadId: row.threadId, createdAt: row.createdAt };
}

/** Pending actions, server-side only, persisted so a restart or a deploy does
 * not silently close an invitation the person was still reviewing. A requestId
 * that is missing, expired, or already consumed resolves to nothing, so a
 * stale or replayed card can never fire an action. */
export class PendingConnectorActions {
  private readonly pending = new Map<string, PendingConnectorAction>();
  /** What a consumed request already did. A repeated tap on Confirm must
   * return this instead of falling through to the generic card resolver,
   * which would report the action as never run and read as a refusal. */
  private readonly settled = new Map<string, string>();
  private readonly settledAt = new Map<string, number>();
  /** Requests that were live and passed their TTL. Kept so an old card can be
   * told it expired instead of being mistaken for a stranger's request. */
  private readonly expired = new Map<string, number>();
  /** Claimed and currently executing. A second concurrent tap must neither
   * start a duplicate action nor be treated as expiry. */
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly file: string | undefined;

  constructor(now: () => number = Date.now, file?: string) {
    this.now = now;
    this.file = file;
    if (file) this.load();
  }

  submit(args: {
    target: unknown;
    botId: string;
    threadId: string;
  }): PendingConnectorAction {
    const parsed = calendarInviteSchema.safeParse(args.target);
    if (!parsed.success) throw new ConnectorActionError("invalid connector action", 400);

    this.evictExpired();
    const live = [...this.pending.values()].filter((action) => action.threadId === args.threadId);
    if (live.length >= MAX_PENDING_PER_THREAD) {
      throw new ConnectorActionError("too many pending connector actions on this conversation", 429);
    }

    const action: PendingConnectorAction = {
      requestId: newId(),
      target: parsed.data,
      botId: args.botId,
      threadId: args.threadId,
      createdAt: this.now(),
    };
    this.pending.set(action.requestId, action);
    this.save();
    return action;
  }

  /** Consume exactly once. Everything else — miss, expiry, replay — is nothing. */
  take(requestId: string): PendingConnectorAction | undefined {
    this.evictExpired();
    const action = this.pending.get(requestId);
    if (!action) return undefined;
    this.pending.delete(requestId);
    this.inFlight.add(requestId);
    this.save();
    return action;
  }

  /** A claimed action whose delivery failed goes back, so one transient error
   * (Tool Layer restart, Google 5xx) does not destroy a confirmation the
   * person already gave. Never resurrects a settled action. */
  restore(action: PendingConnectorAction): void {
    if (this.settled.has(action.requestId)) return;
    this.inFlight.delete(action.requestId);
    this.expired.delete(action.requestId);
    this.pending.set(action.requestId, action);
    this.save();
  }

  peek(requestId: string): PendingConnectorAction | undefined {
    this.evictExpired();
    return this.pending.get(requestId);
  }

  /** A tap that arrives while another is still delivering: not a duplicate and
   * not an expiry, so the caller can say it is already being confirmed. */
  isInFlight(requestId: string): boolean {
    return this.inFlight.has(requestId);
  }

  /** Record the outcome of a consumed action, so an identical repeat is
   * answered from history instead of being treated as a stranger's request. */
  settle(requestId: string, outcome: string): void {
    this.settled.set(requestId, outcome);
    this.settledAt.set(requestId, this.now());
    this.inFlight.delete(requestId);
    this.save();
  }

  settledOutcome(requestId: string): string | undefined {
    this.evictExpired();
    return this.settled.get(requestId);
  }

  /** True only for a request this store submitted and then evicted past its
   * TTL — never merely because no entry is present. */
  expiredOutcome(requestId: string): boolean {
    this.evictExpired();
    return this.expired.has(requestId);
  }

  /** Whether this requestId belongs to this store at all. Used to recognize a
   * card whose pending entry is gone without trusting a provider-authored tool
   * name that could collide with ours. */
  isKnown(requestId: string): boolean {
    this.evictExpired();
    return this.pending.has(requestId) || this.settled.has(requestId) || this.expired.has(requestId);
  }

  private evictExpired(): void {
    const now = this.now();
    const cutoff = now - CONNECTOR_ACTION_TTL_MS;
    let changed = false;
    for (const [id, action] of this.pending) {
      if (action.createdAt <= cutoff) {
        this.pending.delete(id);
        this.expired.set(id, now);
        changed = true;
      }
    }
    // Keep a consumed or expired request replayable a little longer than it
    // was open, so a slow second tap still lands on a truthful state.
    const forget = now - CONNECTOR_ACTION_TTL_MS * 2;
    for (const [id, at] of this.expired) {
      if (at <= forget) {
        this.expired.delete(id);
        changed = true;
      }
    }
    for (const [id] of this.settled) {
      if (!this.pending.has(id)) {
        const at = this.settledAt.get(id);
        if (at !== undefined && at <= forget) {
          this.settled.delete(id);
          this.settledAt.delete(id);
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return; // absent or unreadable: no pending actions
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const store = raw as Record<string, unknown>;
    if (store.version !== STORE_VERSION) return;
    if (Array.isArray(store.pending)) {
      for (const row of store.pending.slice(-MAX_STORED)) {
        const action = storedAction(row);
        if (action) this.pending.set(action.requestId, action);
      }
    }
    if (Array.isArray(store.settled)) {
      for (const row of store.settled.slice(-MAX_STORED)) {
        if (!row || typeof row !== "object") continue;
        const entry = row as Record<string, unknown>;
        if (typeof entry.requestId !== "string" || typeof entry.outcome !== "string") continue;
        if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
        this.settled.set(entry.requestId, entry.outcome);
        this.settledAt.set(entry.requestId, entry.at);
      }
    }
    if (Array.isArray(store.expired)) {
      for (const row of store.expired.slice(-MAX_STORED)) {
        if (!row || typeof row !== "object") continue;
        const entry = row as Record<string, unknown>;
        if (typeof entry.requestId !== "string") continue;
        if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
        this.expired.set(entry.requestId, entry.at);
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    const payload = JSON.stringify({
      version: STORE_VERSION,
      pending: [...this.pending.values()],
      settled: [...this.settled].map(([requestId, outcome]) => ({
        requestId,
        outcome,
        at: this.settledAt.get(requestId) ?? this.now(),
      })),
      expired: [...this.expired].map(([requestId, at]) => ({ requestId, at })),
    });
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, payload, { mode: 0o600 });
    } catch (error) {
      // Kept in memory for this run; a restart may forget an open card.
      console.warn(`connector actions: could not save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface ConfirmedToolCall {
  toolBaseUrl: string;
  agent: string;
  actorAssertion: string;
  tool: string;
  args: Record<string, unknown>;
}

function toolText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const first = (content[0] as { text?: unknown } | undefined)?.text;
  return typeof first === "string" ? first : undefined;
}

/** The Meet link a confirmed create returned, when the tool layer included one. */
export function confirmedMeetLink(result: unknown): string | undefined {
  const text = toolText(result);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { meetLink?: unknown };
    return typeof parsed.meetLink === "string" && /^https?:\/\//.test(parsed.meetLink)
      ? parsed.meetLink
      : undefined;
  } catch {
    return undefined;
  }
}

export interface RelayToolResult {
  ok: boolean;
  /** The tool's refusal text, or "" on success. */
  text: string;
  result: unknown;
}

/**
 * Call one Tool Layer MCP tool with a signed actor assertion, returning a
 * refusal instead of throwing so a durable background caller can classify it
 * (retryable infrastructure vs terminal validation). Transport/connection
 * failures still throw: those are always retryable.
 */
export async function callRelayTool(input: ConfirmedToolCall): Promise<RelayToolResult> {
  let base: URL;
  try {
    // RELAY_TOOL_URL is server configuration, never client/model input. On a
    // compose deployment it is the Tool Layer's service origin
    // (http://tools:8787), so a loopback-only check would reject every
    // confirmed action in production. Validate it as a bare http(s) origin
    // instead; identity still comes from the signed actor assertion.
    relayToolOrigin(input.toolBaseUrl);
    base = new URL(input.toolBaseUrl);
  } catch {
    throw new ConnectorActionError("the Tool Layer is not configured", 503);
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "relay-tool-call", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${input.agent}`, base), {
    requestInit: { headers: { "x-relay-actor-user": input.actorAssertion } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: input.tool, arguments: input.args });
    return {
      ok: result.isError !== true,
      text: toolText(result) ?? "",
      result,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Execute a user-confirmed action through the Tool Layer's own MCP route, so
 * the same registration, permission checks, and actor assertion the agent's
 * tools use apply here too. The model never makes this call; the harness does,
 * after the user confirmed the preview. Never construct this from
 * model-supplied headers — the actor assertion always comes from the signed
 * session the resolve endpoint authenticated.
 */
export async function callConfirmedRelayTool(input: ConfirmedToolCall): Promise<unknown> {
  const outcome = await callRelayTool(input);
  if (!outcome.ok) {
    throw new ConnectorActionError(outcome.text || "the confirmed action failed", 502);
  }
  return outcome.result;
}
