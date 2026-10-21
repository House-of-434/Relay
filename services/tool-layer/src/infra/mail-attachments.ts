// Outbound email attachments.
//
// A file reaches an email through the same store the chat already uses:
// attach_file copies it into DATA_DIR/attachments under an opaque
// <uuid><ext> name and returns that basename as a ref. The Tool Layer reads
// the store directly (the compose volume and the bare-process default put it
// on the same path) so no file bytes travel through the model.
//
// An inbound ref names an attachment on a message the agent read with
// gmail_read. It is forwarded unresolved: only the BFF holds Google
// credentials, and it re-checks that the attachment id belongs to that
// message before fetching the bytes.
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { dataDir } from "../config.js";

export const MAX_OUTBOUND_ATTACHMENTS = 10;
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_OUTBOUND_TOTAL_BYTES = 25 * 1024 * 1024;

export interface StoreAttachmentRef {
  source: "attachment";
  ref: string;
  filename?: string;
}

export interface InboundAttachmentRef {
  source: "inbound";
  messageId: string;
  attachmentId: string;
}

export type OutboundAttachmentRef = StoreAttachmentRef | InboundAttachmentRef;

/** The flat shape the tool advertises. Engines flatten JSON-Schema
 * composition, so the source-specific fields are validated here rather than
 * expressed as a union in the schema. */
export interface OutboundAttachmentInput {
  source: "attachment" | "inbound";
  ref?: string;
  filename?: string;
  messageId?: string;
  attachmentId?: string;
}

export interface InlineAttachment {
  filename: string;
  mimeType: string;
  data: string;
}

/** What the BFF send route accepts: bytes the Tool Layer resolved from the
 * store, or an inbound ref it resolves against the mailbox itself. */
export type BffAttachment = InlineAttachment | { messageId: string; attachmentId: string };

/** The exact names the attachment store writes: a UUID plus an extension.
 * Anything else (a path, a dotfile, a name from the model) is not a ref. */
const ATTACHMENT_REF = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9]{1,16}$/;

/** The formats attach_file accepts, by the extension the store writes. Shared
 * shapes stay documents: the BFF adds its own header-injection and blocked-type
 * checks for inbound files the store never held. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf",
};

/** A display name comes from the model, so it is reduced to one basename; the
 * BFF still flattens header-breaking characters before writing the part. */
function displayName(requested: string | undefined, fallback: string): string {
  const name = (requested ?? "").replace(/\\/g, "/").split("/").pop()?.trim();
  return (name || fallback).slice(0, 255);
}

/** Check the source-specific fields the flat schema cannot. */
export function normalizeOutboundAttachmentRefs(
  entries: readonly OutboundAttachmentInput[],
): OutboundAttachmentRef[] {
  return entries.map((entry, index) => {
    if (entry.source === "attachment") {
      if (!entry.ref) {
        throw new Error(`attachments[${index}] needs a ref from attach_file when source is "attachment"`);
      }
      return {
        source: "attachment",
        ref: entry.ref,
        ...(entry.filename ? { filename: entry.filename } : {}),
      };
    }
    if (entry.source === "inbound") {
      if (!entry.messageId || !entry.attachmentId) {
        throw new Error(`attachments[${index}] needs messageId and attachmentId when source is "inbound"`);
      }
      return { source: "inbound", messageId: entry.messageId, attachmentId: entry.attachmentId };
    }
    throw new Error(`attachments[${index}].source must be "attachment" or "inbound"`);
  });
}

/**
 * Turn model-supplied refs into what the BFF send route accepts. Store refs
 * are read and base64-encoded here; inbound refs pass through untouched.
 * Refuses before anything is sent: a missing, oversized, or unknown file must
 * produce one clear refusal, not a half-sent email.
 */
export function resolveOutboundAttachments(
  refs: readonly OutboundAttachmentRef[],
  options: { attachmentsDir?: string } = {},
): BffAttachment[] {
  if (refs.length === 0) return [];
  if (refs.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new Error(`an email can carry at most ${MAX_OUTBOUND_ATTACHMENTS} attachments`);
  }
  const root = resolve(options.attachmentsDir ?? join(dataDir(), "attachments"));
  let total = 0;
  const out: BffAttachment[] = [];

  for (const entry of refs) {
    if (entry.source === "inbound") {
      out.push({ messageId: entry.messageId, attachmentId: entry.attachmentId });
      continue;
    }
    if (!ATTACHMENT_REF.test(entry.ref)) {
      throw new Error(`"${entry.ref}" is not a file ref; attach the file with attach_file and pass the ref it returns`);
    }
    const mimeType = MIME_BY_EXTENSION[extname(entry.ref).toLowerCase()];
    if (!mimeType) {
      throw new Error(`"${entry.ref}" is not a supported email attachment type`);
    }
    // resolve() plus the containment check keeps a ref from naming anything
    // outside the attachment store even if the pattern above ever loosens.
    const path = resolve(root, entry.ref);
    if (path === root || !path.startsWith(`${root}${sep}`)) {
      throw new Error(`"${entry.ref}" is not a file ref; attach the file with attach_file and pass the ref it returns`);
    }
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`the attached file "${entry.ref}" is no longer available; attach it again with attach_file`);
    }
    if (stat.size === 0) throw new Error(`the attached file "${entry.ref}" is empty`);
    if (stat.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error(`"${entry.filename ?? entry.ref}" is larger than ${MAX_OUTBOUND_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
    }
    total += stat.size;
    if (total > MAX_OUTBOUND_TOTAL_BYTES) {
      throw new Error(`the email attachments exceed ${MAX_OUTBOUND_TOTAL_BYTES / (1024 * 1024)} MB in total`);
    }
    out.push({
      filename: displayName(entry.filename, entry.ref),
      mimeType,
      data: readFileSync(path).toString("base64"),
    });
  }
  return out;
}
