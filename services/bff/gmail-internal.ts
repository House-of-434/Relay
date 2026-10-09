import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { verifyActorAssertion, type RelayActor } from "./actor-assertion.ts";
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

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 512;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 250;
const MAX_ADDRESS_LENGTH = 320;
const MAX_BODY_LENGTH = 20_000;
const MAX_LIST_RESULTS = 50;

const messagesListSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  maxResults: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
}).strict();

const messagesGetSchema = z.object({
  messageId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
}).strict();

const sendSchema = z.object({
  to: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).min(1).max(20),
  cc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  bcc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  subject: z.string().max(MAX_SUBJECT_LENGTH),
  body: z.string().max(MAX_BODY_LENGTH),
}).strict();

export interface InternalGmailOptions {
  googleApi: GoogleApiGateway;
  listAccounts: (userId: string) => Promise<GoogleConnectionMetadata[]>;
  capability: string;
  actorSecret: string | undefined;
  now?: () => number;
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

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function capabilityMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (!match || Buffer.byteLength(match[1]!) > 4096) return false;
  return timingSafeEqual(hash(match[1]!), expectedHash);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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
async function resolveAccount(
  options: InternalGmailOptions,
  actor: RelayActor,
): Promise<GoogleConnectionMetadata | undefined> {
  const gmailAccounts = (await options.listAccounts(actor.userId)).filter((account) => account.service === "gmail");
  if (gmailAccounts.length === 0) return undefined;
  // Ambiguity must fail loudly rather than silently choosing a mailbox.
  if (gmailAccounts.length > 1) throw new Error("multiple connected Gmail accounts");
  return gmailAccounts[0]!;
}

export async function handleInternalGmail(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalGmailOptions,
): Promise<void> {
  const expectedHash = hash(options.capability);
  req.resume();
  if (!capabilityMatches(req, expectedHash)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (!/^application\/json\b/i.test(headerString(req.headers["content-type"]) ?? "")) {
    json(res, 415, { error: "send the request as JSON" });
    return;
  }

  let actor: RelayActor;
  try {
    actor = verifyActorAssertion(
      headerString(req.headers["x-relay-actor-user"]),
      options.actorSecret,
      options.now?.() ?? Date.now(),
    );
  } catch {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    json(res, 400, { error: "invalid request body" });
    return;
  }

  let account: GoogleConnectionMetadata | undefined;
  try {
    account = await resolveAccount(options, actor);
  } catch {
    json(res, 409, { error: "several Gmail accounts are connected for this user" });
    return;
  }
  if (!account) {
    json(res, 404, { error: "Gmail is not connected for this user" });
    return;
  }

  try {
    if (pathname === INTERNAL_GMAIL_MESSAGES_LIST) {
      const parsed = messagesListSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid Gmail search" });
        return;
      }
      const result = await options.googleApi.withClient(
        actor.userId,
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
        actor.userId,
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
      actor.userId,
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