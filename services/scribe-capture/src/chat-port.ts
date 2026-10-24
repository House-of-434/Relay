/** Inbound meeting chat → transcript segments.
 *
 * Chat is stored as ordinary transcript segments with `source: "chat"`, so it
 * rides the existing spool → ingest upsert → read tools with no schema change and
 * no second ordering story. The message key is stable per platform message, so a
 * re-flush upserts the same row instead of duplicating it.
 *
 * Invariants:
 * - `toChatSegment` is pure and total: empty/whitespace text returns null (the
 *   caller skips it) rather than writing a blank row.
 * - `segment_key` is `chat:<platform>:<message_key>` — stable across re-flush.
 * - Chat time comes from the page clock, rebased to meeting-relative seconds, the
 *   same clock speech segments use, so a transcript reads in one order.
 */

import { createHash } from "node:crypto";

import type { Platform, Segment } from "./types.js";

/** Upper bound on a chat body. Matches the widest platform limit we store; a
 *  longer message is truncated rather than rejected, so one long paste cannot
 *  drop a row. */
export const CHAT_MAX_CHARS = 2000;

export interface InboundChat {
  /** Platform message id when the page exposes one; else a content hash. */
  message_key: string;
  sender: string | null;
  text: string;
  /** Epoch ms from the page. */
  atMs: number;
  platform: Platform;
}

/** A chat message as drained from the page. `message_id` is the platform's
 *  own id for the row when the adapter could read one; `stamp` is the row's
 *  timestamp attribute when present; `ordinal` is the row's position among
 *  the currently rendered rows. Any of them may be absent; absence means the
 *  page gave no identity of that kind for the row. */
export interface DrainedChatMessage {
  sender: string | null;
  text: string;
  /** Epoch ms from the page. */
  atMs: number;
  message_id?: string | null;
  stamp?: string | null;
  ordinal?: number | null;
}

/** Stable key for a chat message. The page-provided identity wins when
 *  present, so genuinely repeated lines stay distinct while a re-flush of
 *  the same row maps back to the same key. Without page identity, falls
 *  back to the sender+text+second hash. */
export function chatMessageKey(message: DrainedChatMessage): string {
  const id = message.message_id?.trim();
  if (id) return `id:${id}`;
  const stamp = message.stamp?.trim();
  if (stamp) return `content:${contentHash(message.sender, message.text, stamp)}`;
  if (typeof message.ordinal === "number" && Number.isFinite(message.ordinal)) {
    return `row:${message.ordinal}:${contentHash(message.sender, message.text, "")}`;
  }
  const second = Math.floor(message.atMs / 1000);
  return contentHash(message.sender, message.text, String(second));
}

function contentHash(sender: string | null, text: string, extra: string): string {
  return createHash("sha256")
    .update(`${sender ?? ""}\u0000${text}\u0000${extra}`)
    .digest("hex")
    .slice(0, 16);
}

/** Chat message → transcript segment, or null when there is nothing to store. */
export function toChatSegment(message: InboundChat, captureStartMs: number): Segment | null {
  const text = message.text.trim().slice(0, CHAT_MAX_CHARS);
  if (!text) return null;
  const startSeconds = Math.max(0, (message.atMs - captureStartMs) / 1000);
  // Reading pace (~15 chars/s) gives chat rows a nonzero span so they render in
  // order against speech without claiming a duration anyone measured.
  const duration = Math.max(1, text.length / 15);
  return {
    segment_key: `chat:${message.platform}:${message.message_key}`,
    speaker: message.sender,
    start_seconds: Number(startSeconds.toFixed(2)),
    end_seconds: Number((startSeconds + duration).toFixed(2)),
    text,
    channel: null,
    speaker_key: null,
    source: "chat",
    confidence: null,
    language: null,
  };
}

/** Bounded set of chat keys already turned into segments. Chat panels re-render
 *  the whole visible list, so every poll re-offers old messages; without this the
 *  same message would be re-converted on every tick. */
export class SeenChatSet {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 2000) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }
}

/** Convert raw page messages into unseen segments, advancing the seen set. */
export function newChatSegments(
  messages: DrainedChatMessage[],
  options: { platform: Platform; captureStartMs: number; seen: SeenChatSet },
): Segment[] {
  const out: Segment[] = [];
  const batchCounts = new Map<string, number>();
  for (const message of messages) {
    const base = chatMessageKey(message);
    const n = batchCounts.get(base) ?? 0;
    batchCounts.set(base, n + 1);
    const messageKey = n === 0 ? base : `${base}#${n + 1}`;
    if (options.seen.has(messageKey)) continue;
    const segment = toChatSegment({ ...message, message_key: messageKey, platform: options.platform }, options.captureStartMs);
    if (!segment) continue;
    options.seen.add(messageKey);
    out.push(segment);
  }
  return out;
}
