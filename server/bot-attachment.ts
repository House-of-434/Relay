// Lets a bot hand a finished file to the user as a real chat attachment.
// The source is opened with the same hardened resolver the message-file route
// uses (realpath containment, O_NOFOLLOW, size cap), then copied into the
// private attachment store, so the chat never needs to reach into a bot's
// workspace afterwards.
import { basename, posix } from "node:path";
import {
  extensionForFileMime,
  extensionForMime,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  saveFile,
  saveImage,
} from "./attachments.ts";
import { mimeFor, openMessageFile } from "./message-file.ts";
import type { Message } from "./store.ts";

export type BotAttachment = NonNullable<Message["attachments"]>[number];

export const ATTACH_SUPPORTED_TYPES =
  "images (png, jpg, gif, webp), video (mp4, webm, mov), audio (mp3, m4a, aac, wav, ogg, opus, flac), " +
  "pdf, Word/Excel/PowerPoint and OpenDocument files, and csv, tsv, txt, md, json, rtf";

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** A display name for the chat: the model's suggestion if it gave one, else
 * the file's own name. Directory parts are dropped, never trusted. */
function displayNameFor(requested: string | undefined, fallback: string): string {
  const cleaned = requested?.trim().replace(/\\/g, "/");
  const name = cleaned ? posix.basename(cleaned) : "";
  return name || fallback;
}

export interface SaveBotAttachmentInput {
  /** What the model passed: a host path or a path relative to a root. */
  path: string;
  name?: string;
  /** Host directories the bot may read from (its working folder, workspace). */
  roots: readonly string[];
}

export interface SavedBotAttachment {
  attachment: BotAttachment;
  bytes: number;
  /** The canonical source path that was read. Internal only: the Files
   * registry uses it to mint an id when the source is a managed thread file. */
  sourcePath: string;
}

export async function saveBotAttachment(input: SaveBotAttachmentInput): Promise<SavedBotAttachment> {
  const requested = input.path.trim();
  if (!requested) throw statusError(400, "path is required");
  const file = await openMessageFile(requested, input.roots);
  try {
    const mime = mimeFor(file.name);
    const name = displayNameFor(input.name, file.name);
    if (extensionForMime(mime)) {
      if (file.bytes > IMAGE_MAX_BYTES) throw statusError(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
      const saved = saveImage(await file.handle.readFile(), mime);
      return { attachment: { kind: "image", path: saved.path, mime: saved.mime }, bytes: saved.bytes, sourcePath: file.path };
    }
    if (!extensionForFileMime(mime)) {
      throw statusError(415, `${file.name} is not a supported attachment type. Supported: ${ATTACH_SUPPORTED_TYPES}.`);
    }
    if (file.bytes > FILE_MAX_BYTES) throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
    const saved = await saveFile(file.handle.createReadStream({ start: 0, autoClose: false }), name || basename(file.name), mime, {
      expectedBytes: file.bytes,
    });
    return { attachment: { kind: "file", path: saved.path, mime: saved.mime, name: saved.name }, bytes: saved.bytes, sourcePath: file.path };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export type AttachForTurnOutcome<S> =
  | { status: "attached"; saved: S }
  | { status: "limit" }
  | { status: "ended" };

/**
 * Attach one file for one provider turn. Two things must hold while the copy
 * is awaited, so both are handled here rather than in the route:
 *
 * - The per-turn count is exact under parallel calls: the slot is reserved
 *   before the await, so simultaneous calls cannot all pass the same check.
 *   A call that fails or is refused gives its slot back.
 * - Nothing is published for a turn that ended (stopped, replaced, deleted, or
 *   moved) while the copy ran. `stillLive` is asked again after the await,
 *   just before `publish`, and the copy is discarded when it says no.
 */
export async function attachForTurn<S>(
  turn: { attachedFiles?: number },
  max: number,
  hooks: {
    save: () => Promise<S>;
    stillLive: () => boolean;
    publish: (saved: S) => void;
    discard: (saved: S) => void;
  },
): Promise<AttachForTurnOutcome<S>> {
  const used = turn.attachedFiles ?? 0;
  if (used >= max) return { status: "limit" };
  turn.attachedFiles = used + 1;
  let saved: S | undefined;
  let published = false;
  try {
    saved = await hooks.save();
    if (!hooks.stillLive()) return { status: "ended" };
    hooks.publish(saved);
    published = true;
    return { status: "attached", saved };
  } finally {
    if (!published) {
      turn.attachedFiles = Math.max(0, (turn.attachedFiles ?? 1) - 1);
      if (saved !== undefined) hooks.discard(saved);
    }
  }
}
