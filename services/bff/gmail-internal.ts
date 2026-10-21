import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { RelayActor } from "./actor-assertion.ts";
import { verifyInternalRequest } from "./internal-request.ts";
import { extractDocumentText } from "./document-text.ts";
import { GOOGLE_API_SCOPE_CATALOG, GoogleApiGateway } from "./google-api.ts";
import type { GoogleConnectionMetadata } from "./google-connections.ts";

export const INTERNAL_GMAIL_MESSAGES_LIST = "/api/internal/gmail/messages/list";
export const INTERNAL_GMAIL_MESSAGES_GET = "/api/internal/gmail/messages/get";
export const INTERNAL_GMAIL_SEND = "/api/internal/gmail/send";
export const INTERNAL_GMAIL_ATTACHMENT_GET = "/api/internal/gmail/attachments/get";

const INTERNAL_GMAIL_PATHS = [
  INTERNAL_GMAIL_MESSAGES_LIST,
  INTERNAL_GMAIL_MESSAGES_GET,
  INTERNAL_GMAIL_SEND,
  INTERNAL_GMAIL_ATTACHMENT_GET,
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
/** Outbound email attachments (a bot's finished report, a document it made).
 * Per-file and total caps are separate so one message cannot exhaust the
 * request; the base64 cap mirrors the 20 MB decoded cap with expansion room. */
const MAX_OUTBOUND_ATTACHMENTS = 10;
const MAX_OUTBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_OUTBOUND_ATTACHMENT_BYTES / 3) * 4;

/** Files an outbound message may never carry. Gmail rejects some itself and
 * silently rewrites others; refusing here makes the refusal legible. */
const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "bat", "cmd", "com", "scr", "msi", "ps1", "ps2", "psm1", "sh", "bash", "zsh", "dll", "jar", "app", "dmg", "pkg",
  "vbs", "vb", "wsf", "lnk", "iso", "apk", "deb", "rpm", "reg", "hta", "cpl", "msc", "chm",
  "js", "jse", "vbe", "wsh", "wsc", "sct", "pif",
]);
const BLOCKED_ATTACHMENT_MIME = /^(?:application\/(?:x-msdownload|x-executable|x-sh|x-msdos-program|vnd\.microsoft\.portable-executable|x-apple-diskimage|java-archive|javascript|x-javascript|x-vbscript)|text\/(?:javascript|x-vbscript))$/i;

function attachmentExtension(filename: string): string {
  const normalized = filename.trim().replace(/[. ]+$/, "").toLowerCase();
  if (!normalized.includes(".")) return "";
  return normalized.split(".").pop()?.trim() ?? "";
}

function assertSendableAttachment(filename: string, mimeType: string): void {
  const extension = attachmentExtension(filename);
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(extension) || BLOCKED_ATTACHMENT_MIME.test(mimeType.trim())) {
    throw new AttachmentRequestError(400, "executable attachments are not allowed");
  }
  const mime = mimeType.trim().toLowerCase();
  if (!extension && (mime === "" || mime === "application/octet-stream")) {
    throw new AttachmentRequestError(400, "attachment type cannot be verified: rename the file with an extension or convert it to a supported type");
  }
}

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

const attachmentGetSchema = z.object({
  messageId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
  attachmentId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
  mailbox: MAILBOX_INPUT,
}).strict();

const sendSchema = z.object({
  to: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).min(1).max(20),
  cc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  bcc: z.array(z.string().email().max(MAX_ADDRESS_LENGTH)).max(20).optional(),
  subject: z.string().max(MAX_SUBJECT_LENGTH),
  body: z.string().max(MAX_BODY_LENGTH),
  attachments: z.array(z.union([
    z.object({
      filename: z.string().min(1).max(MAX_FILENAME_LENGTH),
      mimeType: z.string().min(1).max(MAX_MIME_LENGTH),
      data: z.string().min(1).max(MAX_OUTBOUND_ATTACHMENT_BASE64_LENGTH),
    }).strict(),
    z.object({
      messageId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
      attachmentId: z.string().min(1).max(MAX_MESSAGE_ID_LENGTH),
    }).strict(),
  ])).max(MAX_OUTBOUND_ATTACHMENTS).optional(),
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

/** Header values must never carry a line break: a CRLF inside a filename or
 * subject could inject a header or a new part. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function mimeParamValue(value: string): string {
  return headerValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function safeMimeType(value: string): string {
  const clean = headerValue(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(clean)) {
    throw new AttachmentRequestError(400, "invalid email attachment type");
  }
  return clean;
}

/** Wrap base64 at 76 characters, the MIME convention Gmail expects. */
function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** Build the RFC822 message Gmail sends. Text-only messages keep the simple
 * shape they always had; attachments switch it to multipart/mixed with the
 * text body first and one base64 part per file. */
function buildRawEmail(input: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: Array<{ filename: string; mimeType: string; data: string }>;
}): string {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${headerValue(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (input.attachments.length === 0) {
    return [...headers, 'Content-Type: text/plain; charset="UTF-8"', "", input.body].join("\r\n");
  }
  let total = 0;
  const parts: string[] = [];
  const boundary = `relay_${randomUUID()}`;
  for (const attachment of input.attachments) {
    // Accept standard base64 only; validate before it becomes a part.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data.replace(/\s+/g, ""))) {
      throw new AttachmentRequestError(400, "invalid email attachment encoding");
    }
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new AttachmentRequestError(bytes.length === 0 ? 400 : 413, "email attachment is too large");
    }
    total += bytes.length;
    if (total > MAX_OUTBOUND_TOTAL_BYTES) {
      throw new AttachmentRequestError(413, "the email attachments are too large");
    }
    const name = mimeParamValue(attachment.filename);
    const mimeType = safeMimeType(attachment.mimeType);
    assertSendableAttachment(attachment.filename, mimeType);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(attachment.data),
    );
  }
  parts.push(`--${boundary}--`, "");
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.body,
    ...parts,
  ].join("\r\n");
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

/** Attachment bytes cap: parity with chat uploads. The agent checks the
 * metadata size first; anything larger is refused rather than truncated. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Binary signatures we can verify. Documents that share a container (OOXML
 * is a ZIP, legacy Office is an OLE compound file) share a class; the
 * declared MIME or the filename extension then picks the exact format. */
type MagicClass = "pdf" | "zip" | "ole" | "png" | "jpeg" | "gif" | "webp" | "text";

interface DocumentFormat {
  kind: string;
  mime: readonly string[];
  extensions: readonly string[];
  magic: MagicClass;
}

/** Formats Relay can hand to the model. Broad on purpose: a request may bring
 * any document, not only a deck, and the same reader serves all of them. */
const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  { kind: "pdf", mime: ["application/pdf"], extensions: ["pdf"], magic: "pdf" },
  { kind: "docx", mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], extensions: ["docx"], magic: "zip" },
  { kind: "xlsx", mime: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], extensions: ["xlsx"], magic: "zip" },
  { kind: "pptx", mime: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], extensions: ["pptx"], magic: "zip" },
  { kind: "odt", mime: ["application/vnd.oasis.opendocument.text"], extensions: ["odt"], magic: "zip" },
  { kind: "ods", mime: ["application/vnd.oasis.opendocument.spreadsheet"], extensions: ["ods"], magic: "zip" },
  { kind: "odp", mime: ["application/vnd.oasis.opendocument.presentation"], extensions: ["odp"], magic: "zip" },
  { kind: "doc", mime: ["application/msword"], extensions: ["doc", "dot"], magic: "ole" },
  { kind: "xls", mime: ["application/vnd.ms-excel"], extensions: ["xls", "xlt"], magic: "ole" },
  { kind: "ppt", mime: ["application/vnd.ms-powerpoint"], extensions: ["ppt", "pps"], magic: "ole" },
  { kind: "rtf", mime: ["application/rtf", "text/rtf"], extensions: ["rtf"], magic: "text" },
  { kind: "png", mime: ["image/png"], extensions: ["png"], magic: "png" },
  { kind: "jpeg", mime: ["image/jpeg"], extensions: ["jpg", "jpeg"], magic: "jpeg" },
  { kind: "gif", mime: ["image/gif"], extensions: ["gif"], magic: "gif" },
  { kind: "webp", mime: ["image/webp"], extensions: ["webp"], magic: "webp" },
  { kind: "csv", mime: ["text/csv"], extensions: ["csv"], magic: "text" },
  { kind: "tsv", mime: ["text/tab-separated-values"], extensions: ["tsv"], magic: "text" },
  { kind: "json", mime: ["application/json"], extensions: ["json"], magic: "text" },
  { kind: "markdown", mime: ["text/markdown"], extensions: ["md", "markdown"], magic: "text" },
  { kind: "text", mime: ["text/plain"], extensions: ["txt", "log", "text"], magic: "text" },
];

class AttachmentRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AttachmentRequestError";
    this.status = status;
  }
}

function startsWithBytes(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** A byte that carries no signature is text only when it decodes cleanly and
 * holds no binary control characters; otherwise it is an unsupported blob. */
function isTextual(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Tab, newline, and carriage return are fine; other C0 controls are binary.
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
  }
  return true;
}

function bytesMagicClass(bytes: Buffer): MagicClass | undefined {
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return bytes.includes(0) ? undefined : (isTextual(bytes) ? "text" : undefined);
}

/** Kinds handed back as image bytes for native vision, not extracted as text. */
const IMAGE_KINDS = new Set(["png", "jpeg", "gif", "webp"]);
const CANONICAL_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Identify an attachment from its bytes, corroborated by the declared MIME or
 * the filename extension. The magic class must match the format, so a
 * mislabeled or spoofed file is rejected rather than parsed as the wrong
 * type. Gmail commonly reports documents as application/octet-stream, which
 * the extension covers. */
function classifyAttachment(mimeType: string, filename: string, bytes: Buffer): string | undefined {
  const magic = bytesMagicClass(bytes);
  if (!magic) return undefined;
  const mime = mimeType.trim().toLowerCase();
  const extension = attachmentExtension(filename);
  const candidates = DOCUMENT_FORMATS.filter((format) => format.magic === magic);
  const byMime = candidates.find((format) => format.mime.includes(mime));
  if (byMime) return byMime.kind;
  return candidates.find((format) => format.extensions.includes(extension))?.kind;
}

function findAttachmentPart(
  payload: GmailPayloadPart | undefined,
  attachmentId: string,
): GmailPayloadPart | undefined {
  let found: GmailPayloadPart | undefined;
  const walk = (part: GmailPayloadPart | null | undefined): void => {
    if (!part || found) return;
    if (part.body?.attachmentId === attachmentId) {
      found = part;
      return;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return found;
}

/** The slice of the Gmail client the two attachment readers share. */
interface AttachmentReader {
  users: {
    messages: {
      attachments: {
        get(input: { userId: string; messageId: string; id: string }): Promise<{ data?: { data?: string | null } | null }>;
      };
    };
  };
}

interface RawAttachmentBytes {
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}

/** Fetch one part's bytes. The caller resolved the part from this exact
 * message, so the id can never name a part of another message. */
async function readAttachmentBytes(
  client: AttachmentReader,
  part: GmailPayloadPart,
  input: { messageId: string; attachmentId: string },
  maxBytes: number,
): Promise<RawAttachmentBytes> {
  const filename = bounded(typeof part.filename === "string" ? part.filename : "", MAX_FILENAME_LENGTH);
  const mimeType = bounded(
    typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "application/octet-stream",
    MAX_MIME_LENGTH,
  );
  // Check the declared size first so an oversized part is refused without
  // asking Google for its bytes.
  const declaredSize = part.body?.size;
  if (typeof declaredSize === "number" && declaredSize > maxBytes) {
    throw new AttachmentRequestError(413, "attachment is too large");
  }
  const fetched = await client.users.messages.attachments.get({
    userId: "me",
    messageId: input.messageId,
    id: input.attachmentId,
  });
  const encoded = fetched.data?.data;
  if (typeof encoded !== "string" || !encoded) {
    throw new AttachmentRequestError(502, "Gmail request failed");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0) throw new AttachmentRequestError(400, "attachment is empty");
  if (bytes.length > maxBytes) throw new AttachmentRequestError(413, "attachment is too large");
  return { filename, mimeType, size: bytes.length, data: bytes.toString("base64") };
}

/** Resolve forwarded attachment ids against the mailbox the send is from.
 * Each message is fetched once per send, however many of its parts are
 * forwarded, and every id is checked against that same payload. */
async function resolveInboundSendAttachments(
  options: InternalGmailOptions,
  account: GoogleConnectionMetadata,
  ownerUserId: string,
  refs: ReadonlyArray<{ messageId: string; attachmentId: string }>,
): Promise<Array<{ filename: string; mimeType: string; data: string }>> {
  return options.googleApi.withClient(
    ownerUserId,
    "gmail",
    account.id,
    [GOOGLE_API_SCOPE_CATALOG.gmail.read],
    async (client) => {
      const payloads = new Map<string, GmailPayloadPart | undefined>();
      const out: Array<{ filename: string; mimeType: string; data: string }> = [];
      let totalBytes = 0;
      for (const ref of refs) {
        if (!payloads.has(ref.messageId)) {
          const full = await client.users.messages.get({ userId: "me", id: ref.messageId, format: "full" });
          payloads.set(ref.messageId, full.data.payload as GmailPayloadPart | undefined);
        }
        const part = findAttachmentPart(payloads.get(ref.messageId), ref.attachmentId);
        if (!part) {
          throw new AttachmentRequestError(400, "an attachment you named is not part of that message");
        }
        // Refuse a blocked type before asking Google for its bytes.
        assertSendableAttachment(
          typeof part.filename === "string" ? part.filename : "",
          typeof part.mimeType === "string" ? part.mimeType : "",
        );
        const declaredSize = part.body?.size;
        if (typeof declaredSize === "number" && Number.isFinite(declaredSize) && declaredSize > 0) {
          if (totalBytes + declaredSize > MAX_OUTBOUND_TOTAL_BYTES) {
            throw new AttachmentRequestError(413, "the email attachments are too large");
          }
        }
        const bytes = await readAttachmentBytes(client, part, ref, MAX_OUTBOUND_ATTACHMENT_BYTES);
        totalBytes += bytes.size;
        if (totalBytes > MAX_OUTBOUND_TOTAL_BYTES) {
          throw new AttachmentRequestError(413, "the email attachments are too large");
        }
        out.push({ filename: bytes.filename || "attachment", mimeType: bytes.mimeType, data: bytes.data });
      }
      return out;
    },
  );
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

export interface FetchedGmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  size: number;
  data: string;
}

/** Fetch one attachment's bytes for a verified actor, from the actor's own or
 * the shared mailbox. Shared by the attachment route and the Notion
 * deck-attach route, so both honor the same message-scoped check, size cap,
 * and content-type validation. Throws AttachmentRequestError on refusal. */
export async function fetchGmailAttachment(
  options: InternalGmailOptions,
  actor: RelayActor,
  input: { messageId: string; attachmentId: string; mailbox?: "own" | "relay" },
): Promise<{ email: string; attachment: FetchedGmailAttachment }> {
  const resolved = await resolveAccount(options, actor, input.mailbox === "relay" ? "relay" : "own");
  if (!resolved) throw new AttachmentRequestError(404, "Gmail is not connected for this user");
  const { account, ownerUserId } = resolved;
  const attachment = await options.googleApi.withClient(
    ownerUserId,
    "gmail",
    account.id,
    [GOOGLE_API_SCOPE_CATALOG.gmail.read],
    async (client) => {
      const full = await client.users.messages.get({
        userId: "me",
        id: input.messageId,
        format: "full",
      });
      // The attachment id is honored only when it names a part of this
      // message: an id from another message can never be smuggled in.
      const part = findAttachmentPart(full.data.payload as GmailPayloadPart | undefined, input.attachmentId);
      if (!part) throw new AttachmentRequestError(404, "attachment not found");
      const bytes = await readAttachmentBytes(client, part, input, ATTACHMENT_MAX_BYTES);
      const kind = classifyAttachment(bytes.mimeType, bytes.filename, Buffer.from(bytes.data, "base64"));
      if (!kind) throw new AttachmentRequestError(400, "unsupported attachment type");
      return { id: input.attachmentId, ...bytes, kind };
    },
  );
  return { email: account.email, attachment };
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
    // A send may carry base64 attachments; every other route stays at the
    // small default so a body cannot grow unbounded. Allow for base64
    // expansion plus JSON overhead on top of the decoded total cap.
    ...(pathname === INTERNAL_GMAIL_SEND
      ? { maxBodyBytes: Math.ceil(MAX_OUTBOUND_TOTAL_BYTES * 4 / 3) + 1024 * 1024 }
      : {}),
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

    if (pathname === INTERNAL_GMAIL_ATTACHMENT_GET) {
      const parsed = attachmentGetSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid Gmail attachment request" });
        return;
      }
      try {
        const { email, attachment } = await fetchGmailAttachment(options, actor, {
          messageId: parsed.data.messageId,
          attachmentId: parsed.data.attachmentId,
          mailbox: parsed.data.mailbox,
        });
        const meta = {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          size: attachment.size,
        };
        // An image is handed back as image bytes, so the tool can present it
        // to a vision-capable model rather than as unreadable text.
        if (IMAGE_KINDS.has(attachment.kind)) {
          json(res, 200, {
            account: { email },
            attachment: { ...meta, image: { mimeType: CANONICAL_IMAGE_MIME[attachment.kind]!, data: attachment.data } },
          });
          return;
        }
        // A document is read here, server-side, so the model receives text it
        // can actually use instead of base64 it cannot.
        const extracted = await extractDocumentText(attachment.kind, Buffer.from(attachment.data, "base64"));
        json(res, 200, {
          account: { email },
          attachment: {
            ...meta,
            text: extracted.text,
            warnings: extracted.warnings,
            ...(extracted.unreadable ? { unreadable: true } : {}),
            ...(extracted.noText ? { noText: true } : {}),
          },
        });
        return;
      } catch (error) {
        if (error instanceof AttachmentRequestError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
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
    const requested = parsed.data.attachments ?? [];
    const inbound = requested.filter(
      (entry): entry is { messageId: string; attachmentId: string } => "messageId" in entry,
    );
    const inline = requested.filter(
      (entry): entry is { filename: string; mimeType: string; data: string } => !("messageId" in entry),
    );
    let attachments: Array<{ filename: string; mimeType: string; data: string }>;
    try {
      attachments = inbound.length
        ? [...inline, ...(await resolveInboundSendAttachments(options, account, ownerUserId, inbound))]
        : inline;
    } catch (error) {
      if (error instanceof AttachmentRequestError) {
        json(res, error.status, { error: error.message });
        return;
      }
      throw error;
    }
    let rawMessage: string;
    try {
      rawMessage = buildRawEmail({
        to: parsed.data.to,
        cc,
        bcc,
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachments,
      });
    } catch (error) {
      json(res, error instanceof AttachmentRequestError ? error.status : 400, {
        error: error instanceof Error ? error.message : "invalid Gmail message",
      });
      return;
    }
    const sent = await options.googleApi.withClient(
      ownerUserId,
      "gmail",
      account.id,
      [GOOGLE_API_SCOPE_CATALOG.gmail.drafts],
      async (client) => {
        const response = await client.users.messages.send({
          userId: "me",
          requestBody: { raw: Buffer.from(rawMessage, "utf8").toString("base64url") },
        });
        return { id: response.data.id, threadId: response.data.threadId };
      },
    );
    json(res, 200, { account: { email: account.email }, sent, to: parsed.data.to, cc, bcc });
  } catch {
    json(res, 502, { error: "Gmail request failed" });
  }
}