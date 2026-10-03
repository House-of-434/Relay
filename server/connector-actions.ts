import { z } from "zod";

import { newId } from "./contracts.ts";

/**
 * User-confirmed Google actions. The card the user sees is display-only: the
 * pending action lives here, keyed by requestId, and the resolve path looks
 * it up instead of trusting anything on the wire. No wire payload was added
 * for these on purpose — the draft id and event id must never reach the
 * browser, where they could be substituted.
 */

export const CONNECTOR_ACTION_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_THREAD = 10;
const MAX_EMAILS = 20;
const MAX_ADDRESS = 320;
const MAX_SUBJECT = 250;
const MAX_BODY = 20_000;
const MAX_DISPLAY_BODY = 2_000;
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
}).strict();

const emailSendSchema = z.object({
  to: z.array(email).min(1).max(MAX_EMAILS),
  cc: z.array(email).max(MAX_EMAILS).optional(),
  bcc: z.array(email).max(MAX_EMAILS).optional(),
  subject: z.string().max(MAX_SUBJECT),
  body: z.string().min(1).max(MAX_BODY),
}).strict();

export type ConnectorActionKind = "calendar-invite" | "gmail-send";

export interface CalendarInviteTarget {
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  when: string;
  attendees: string[];
  description?: string;
  location?: string;
  timeZone?: string;
}

export interface GmailSendTarget {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export type ConnectorActionTarget = CalendarInviteTarget | GmailSendTarget;

export interface PendingConnectorAction {
  requestId: string;
  kind: ConnectorActionKind;
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

export function connectorActionDisplay(kind: ConnectorActionKind, target: ConnectorActionTarget): {
  title: string;
  subtitle: string;
  detail: string;
} {
  if (kind === "calendar-invite") {
    const invite = target as CalendarInviteTarget;
    return {
      title: "Confirm event and invitations",
      subtitle: `${invite.summary} · ${invite.when}`,
      detail: `Attendees (${invite.attendees.length}): ${attendeeNames(invite.attendees)}\n\nConfirming creates this on your primary calendar and Google emails invitations to ${invite.attendees.length === 1 ? "this attendee" : "all these attendees"}.`,
    };
  }
  const send = target as GmailSendTarget;
  const body = send.body.length > MAX_DISPLAY_BODY
    ? `${send.body.slice(0, MAX_DISPLAY_BODY)}\n\n…(truncated for display; the full text will be sent)`
    : send.body;
  const cc = send.cc ?? [];
  const bcc = send.bcc ?? [];
  const total = send.to.length + cc.length + bcc.length;
  // Bcc is invisible by design, so it is rendered as its own line: a hidden
  // recipient must never slip past the owner unnoticed.
  const lines = [
    `To: ${attendeeNames(send.to)}`,
    ...(cc.length ? [`Cc: ${attendeeNames(cc)}`] : []),
    ...(bcc.length ? [`Bcc (hidden from other recipients): ${attendeeNames(bcc)}`] : []),
  ];
  return {
    title: "Confirm email",
    subtitle: lines.join("\n"),
    detail: `Subject: ${send.subject || "(no subject)"}\n\n${body}\n\nThis message will be sent to ${total === 1 ? "1 recipient" : `${total} recipients`}.`,
  };
}

/** Pending actions, server-side only. A requestId that is missing, expired,
 * or already consumed resolves to nothing, so a stale or replayed card can
 * never fire an action. */
export class PendingConnectorActions {
  private readonly pending = new Map<string, PendingConnectorAction>();
  /** What a consumed request already did. A repeated tap on Confirm must
   * return this instead of falling through to the generic card resolver,
   * which would report the action as never run and read as a refusal. */
  private readonly settled = new Map<string, string>();
  private readonly settledAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  submit(args: {
    kind: ConnectorActionKind;
    target: unknown;
    botId: string;
    threadId: string;
  }): PendingConnectorAction {
    const parsed = args.kind === "calendar-invite"
      ? calendarInviteSchema.safeParse(args.target)
      : emailSendSchema.safeParse(args.target);
    if (!parsed.success) throw new ConnectorActionError("invalid connector action", 400);

    this.evictExpired();
    const live = [...this.pending.values()].filter((action) => action.threadId === args.threadId);
    if (live.length >= MAX_PENDING_PER_THREAD) {
      throw new ConnectorActionError("too many pending connector actions on this conversation", 429);
    }

    const action: PendingConnectorAction = {
      requestId: newId(),
      kind: args.kind,
      target: parsed.data as ConnectorActionTarget,
      botId: args.botId,
      threadId: args.threadId,
      createdAt: this.now(),
    };
    this.pending.set(action.requestId, action);
    return action;
  }

  /** Consume exactly once. Everything else — miss, expiry, replay — is nothing. */
  take(requestId: string): PendingConnectorAction | undefined {
    this.evictExpired();
    const action = this.pending.get(requestId);
    if (!action) return undefined;
    this.pending.delete(requestId);
    return action;
  }

  peek(requestId: string): PendingConnectorAction | undefined {
    this.evictExpired();
    return this.pending.get(requestId);
  }

  /** Record the outcome of a consumed action, so an identical repeat is
   * answered from history instead of being treated as a stranger's request. */
  settle(requestId: string, outcome: string): void {
    this.settled.set(requestId, outcome);
    this.settledAt.set(requestId, this.now());
  }

  settledOutcome(requestId: string): string | undefined {
    this.evictExpired();
    return this.settled.get(requestId);
  }

  private evictExpired(): void {
    const cutoff = this.now() - CONNECTOR_ACTION_TTL_MS;
    for (const [id, action] of this.pending) {
      if (action.createdAt <= cutoff) this.pending.delete(id);
    }
    // Keep a consumed request replayable a little longer than it was open, so
    // a slow second tap still lands on the recorded outcome.
    const replayCutoff = this.now() - CONNECTOR_ACTION_TTL_MS * 2;
    for (const [id] of this.settled) {
      if (!this.pending.has(id)) {
        const at = this.settledAt.get(id);
        if (at !== undefined && at <= replayCutoff) this.settled.delete(id);
      }
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

/**
 * Execute a user-confirmed action through the Tool Layer's own MCP route, so
 * the same registration, permission checks, and actor assertion the agent's
 * tools use apply here too. The model never makes this call; the harness does,
 * after the user confirmed the preview. Never construct this from
 * model-supplied headers — the actor assertion always comes from the signed
 * session the resolve endpoint authenticated.
 */
export async function callConfirmedRelayTool(input: ConfirmedToolCall): Promise<unknown> {
  let base: URL;
  try {
    base = new URL(input.toolBaseUrl);
  } catch {
    throw new ConnectorActionError("the Tool Layer is not configured", 503);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "http:" || !loopback || (base.pathname !== "/" && base.pathname !== "")) {
    throw new ConnectorActionError("the Tool Layer is not configured", 503);
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "relay-confirmed-action", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${input.agent}`, base), {
    requestInit: { headers: { "x-relay-actor-user": input.actorAssertion } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: input.tool, arguments: input.args });
    if (result.isError) {
      throw new ConnectorActionError(toolText(result) ?? "the confirmed action failed", 502);
    }
    return result;
  } finally {
    await client.close().catch(() => undefined);
  }
}
