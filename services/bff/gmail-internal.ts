import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { RelayActor } from "./actor-assertion.ts";
import { verifyInternalRequest } from "./internal-request.ts";
import { GOOGLE_API_SCOPE_CATALOG, GoogleApiGateway } from "./google-api.ts";
import type { GoogleConnectionMetadata } from "./google-connections.ts";

export const INTERNAL_GMAIL_MESSAGES_LIST = "/api/internal/gmail/messages/list";
export const INTERNAL_GMAIL_MESSAGES_GET = "/api/internal/gmail/messages/get";
export const INTERNAL_GMAIL_SEND = "/api/internal/gmail/send";

const INTERNAL_GMAIL_PATHS = [
  INTERNAL_GMAIL_MESSAGES_LIST,
  INTERNAL_GMAIL_MESSAGES_GET,
  INTERNAL_GMAIL_SEND,
] as const;

const MAX_QUERY_LENGTH = 512;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 250;
const MAX_ADDRESS_LENGTH = 320;
const MAX_BODY_LENGTH = 20_000;
const MAX_LIST_RESULTS = 50;
/** Extracted mail text is bounded: enough for a deck-evaluation thread,
 * never the whole mailbox. */
const MAX_EXTRACTED_BODY_LENGTH = 16_000;
const MAX_ATTACHMENTS = 50;
const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_LENGTH = 255;

/** Which connected mailbox a request means: the actor's own account, or
 * Relay's shared mailbox (read/search, plus server-sent notifications). */
const MAILBOX_INPUT = z.enum(["own", "relay"]).optional();

const messagesListSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  maxResults: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
  mailbox: MAILBOX_INPUT,
}).strict();

const messagesGetSchema = z.object({
  messageId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
  mailbox: MAILBOX_INPUT,
}).strict();

const sendSchema = z.object({
  to: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).min(1).max(20),
  cc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  bcc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  subject: z.string().max(MAX_SUBJECT_LENGTH),
  body: z.string().max(MAX_BODY_LENGTH),
  mailbox: MAILBOX_INPUT,
}).strict();

export interface InternalGmailOptions {
  googleApi: GoogleApiGateway;
  listAccounts: (userId: string) => Promise<GoogleConnectionMetadata[]>;
  capability: string;
  actorSecret: string | undefined;
  /** Relay's shared mailbox: address plus the Supabase user id owning its
   * connection. Required only for `mailbox: "relay"`, which fails closed
   * when either is missing. */
  mailboxAddress?: string;
  mailboxUserId?: string;
  now?: () => number;
}

/** The shared mailbox was asked for but is not configured or not connected.
 * Distinct from the actor's own-account errors so the reply stays honest. */
class RelayMailboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayMailboxUnavailableError";
  }
}

export function isInternalGmailPath(pathname: string): boolean {
  return (INTERNAL_GMAIL_PATHS as readonly string[]).includes(pathname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Gmail is reachable only for a verified actor, and only for the single Google
 * account that actor connected. No caller-supplied account, user, or scope is
 * honored, and no token or provider error ever crosses this boundary.
 *
 * The boundary is the shared capability plus the signed actor assertion, not
 * the peer's address: in the compose deployment the Tool Layer is a separate
 * container and is never a loopback peer.
 */
interface GmailPayloadPart {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  parts?: GmailPayloadPart[] | null;
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function decodeBodyData(data: string | null | undefined): string | undefined {
  if (typeof data !== "string" || !data) return undefined;
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Gmail's payload is a recursive part tree. The first non-attachment
 * text/plain part wins; text/html is a fallback when no plain part exists. */
function extractedBody(payload: GmailPayloadPart | undefined): { text?: string; html?: string } {
  let text: string | undefined;
  let html: string | undefined;
  const walk = (part: GmailPayloadPart | null | undefined): void => {
    if (!part) return;
    const isAttachment = typeof part.body?.attachmentId === "string" && part.body.attachmentId.length > 0;
    const mime = (part.mimeType ?? "").toLowerCase();
    if (!isAttachment && mime === "text/plain" && text === undefined) text = decodeBodyData(part.body?.data);
    else if (!isAttachment && mime === "text/html" && html === undefined) html = decodeBodyData(part.body?.data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Attachment metadata only (never bytes): filename, type, size. Fetching an
 * attachment is a separate, size-capped, allowlisted route. */
function attachmentMetadata(payload: GmailPayloadPart | undefined): Array<{ id: string; filename: string; mimeType: string; size?: number }> {
  const out: Array<{ id: string; filename: string; mimeType: string; size?: number }> = [];
  const walk = (part: GmailPayloadPart | null | undefined): void => {
    if (!part || out.length >= MAX_ATTACHMENTS) return;
    const attachmentId = part.body?.attachmentId;
    if (typeof attachmentId === "string" && attachmentId) {
      out.push({
        id: attachmentId,
        filename: bounded(typeof part.filename === "string" ? part.filename : "", MAX_FILENAME_LENGTH),
        mimeType: bounded(typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "application/octet-stream", MAX_MIME_LENGTH),
        ...(typeof part.body?.size === "number" && Number.isFinite(part.body.size)
          ? { size: Math.max(0, Math.trunc(part.body.size)) }
          : {}),
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

interface ResolvedMailbox {
  account: GoogleConnectionMetadata;
  /** The user id whose stored credential opens this mailbox: the actor for
   * "own", the configured owner for "relay". */
  ownerUserId: string;
}

function requestedMailbox(raw: unknown): "own" | "relay" {
  return raw !== null && typeof raw === "object" && (raw as { mailbox?: unknown }).mailbox === "relay" ? "relay" : "own";
}

async function resolveAccount(
  options: InternalGmailOptions,
  actor: RelayActor,
  mailbox: "own" | "relay",
): Promise<ResolvedMailbox | undefined> {
  if (mailbox === "relay") {
    const address = options.mailboxAddress?.trim().toLowerCase();
    const ownerUserId = options.mailboxUserId?.trim();
    if (!address || !ownerUserId) throw new RelayMailboxUnavailableError("Relay's shared mailbox is not configured");
    const accounts = (await options.listAccounts(ownerUserId)).filter((account) => account.service === "gmail");
    const account = accounts.find((candidate) => candidate.email.trim().toLowerCase() === address);
    if (!account) throw new RelayMailboxUnavailableError("Relay's shared mailbox is not connected");
    return { account, ownerUserId };
  }
  const gmailAccounts = (await options.listAccounts(actor.userId)).filter((account) => account.service === "gmail");
  if (gmailAccounts.length === 0) return undefined;
  // Ambiguity must fail loudly rather than silently choosing a mailbox.
  if (gmailAccounts.length > 1) throw new Error("multiple connected Gmail accounts");
  return { account: gmailAccounts[0]!, ownerUserId: actor.userId };
}

export async function handleInternalGmail(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalGmailOptions,
): Promise<void> {
  const verified = await verifyInternalRequest(req, res, pathname, {
    capability: options.capability,
    actorSecret: options.actorSecret,
    now: options.now,
  }, pathname);
  if (!verified) return;
  const actor: RelayActor = verified.actor;
  const raw: unknown = verified.body;

  let resolved: ResolvedMailbox | undefined;
  try {
    resolved = await resolveAccount(options, actor, requestedMailbox(raw));
  } catch (error) {
    if (error instanceof RelayMailboxUnavailableError) {
      json(res, 404, { error: error.message });
      return;
    }
    json(res, 409, { error: "several Gmail accounts are connected for this user" });
    return;
  }
  if (!resolved) {
    json(res, 404, { error: "Gmail is not connected for this user" });
    return;
  }
  const { account, ownerUserId } = resolved;

  try {
    if (pathname === INTERNAL_GMAIL_MESSAGES_LIST) {
      const parsed = messagesListSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid Gmail search" });
        return;
      }
      const result = await options.googleApi.withClient(
        ownerUserId,
        "gmail",
        account.id,
        [GOOGLE_API_SCOPE_CATALOG.gmail.read],
        async (client) => {
          const response = await client.users.messages.list({
            userId: "me",
            q: parsed.data.query,
            maxResults: parsed.data.maxResults ?? MAX_LIST_RESULTS,
          });
          return (response.data.messages ?? []).flatMap((message) => message.id
            ? [{ id: message.id, threadId: message.threadId }]
            : []);
        },
      );
      json(res, 200, { account: { email: account.email }, messages: result });
      return;
    }

    if (pathname === INTERNAL_GMAIL_MESSAGES_GET) {
      const parsed = messagesGetSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid Gmail message id" });
        return;
      }
      const result = await options.googleApi.withClient(
        ownerUserId,
        "gmail",
        account.id,
        [GOOGLE_API_SCOPE_CATALOG.gmail.read],
        async (client) => {
          const response = await client.users.messages.get({
            userId: "me",
            id: parsed.data.messageId,
            format: "full",
          });
          const headers = response.data.payload?.headers ?? [];
          const headerValue = (name: string): string | undefined => {
            const match = headers.find((header) => header.name?.toLowerCase() === name);
            return typeof match?.value === "string" ? match.value.slice(0, MAX_SUBJECT_LENGTH) : undefined;
          };
          const payload = response.data.payload as GmailPayloadPart | undefined;
          const parts = extractedBody(payload);
          const extracted = parts.text ?? (parts.html ? htmlToText(parts.html) : undefined);
          const body = extracted === undefined ? undefined : bounded(extracted, MAX_EXTRACTED_BODY_LENGTH);
          const attachments = attachmentMetadata(payload);
          return {
            id: response.data.id ?? parsed.data.messageId,
            threadId: response.data.threadId,
            from: headerValue("from"),
            to: headerValue("to"),
            subject: headerValue("subject"),
            date: headerValue("date"),
            snippet: typeof response.data.snippet === "string"
              ? response.data.snippet.slice(0, MAX_BODY_LENGTH)
              : undefined,
            ...(body !== undefined ? { body } : {}),
            ...(extracted !== undefined && extracted.length > MAX_EXTRACTED_BODY_LENGTH ? { bodyTruncated: true } : {}),
            ...(attachments.length ? { attachments } : {}),
          };
        },
      );
      json(res, 200, { account: { email: account.email }, message: result });
      return;
    }

    const parsed = sendSchema.safeParse(raw);
    if (pathname !== INTERNAL_GMAIL_SEND || !parsed.success) {
      json(res, pathname === INTERNAL_GMAIL_SEND ? 400 : 404, {
        error: pathname === INTERNAL_GMAIL_SEND ? "invalid Gmail message" : "not found",
      });
      return;
    }
    // Sending happens only after the owner confirmed the exact content; the
    // composed message below is built from this same body, not from a draft
    // the model might have changed since.
    const cc = parsed.data.cc ?? [];
    const bcc = parsed.data.bcc ?? [];
    const sent = await options.googleApi.withClient(
      ownerUserId,
      "gmail",
      account.id,
      [GOOGLE_API_SCOPE_CATALOG.gmail.drafts],
      async (client) => {
        const response = await client.users.messages.send({
          userId: "me",
          requestBody: {
            raw: Buffer.from(
              `To: ${parsed.data.to.join(", ")}\r\n` +
                (cc.length ? `Cc: ${cc.join(", ")}\r\n` : "") +
                (bcc.length ? `Bcc: ${bcc.join(", ")}\r\n` : "") +
                `Subject: ${parsed.data.subject}\r\n\r\n${parsed.data.body}`,
              "utf8",
            ).toString("base64url"),
          },
        });
        return { id: response.data.id, threadId: response.data.threadId };
      },
    );
    json(res, 200, { account: { email: account.email }, sent, to: parsed.data.to, cc, bcc });
  } catch {
    json(res, 502, { error: "Gmail request failed" });
  }
}