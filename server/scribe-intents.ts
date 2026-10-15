/** Manual Scribe join intents: identity, authorization, and the monitor producer.
 *
 * A manual join ("Mercury, join this meeting now") is accepted into the
 * durable intent store (server/message-db.ts) and drained by the monitor
 * through the same arm-if-due loop as calendar requests. Three concepts stay
 * separate by design:
 * - request key: idempotency across retries of the SAME join request;
 * - capture instance id: unique per ACCEPTED capture, never URL-derived;
 * - active-session rule: at most one live capture per meeting URL, enforced
 *   at acceptance against pending/armed intents (not by permanent identity).
 */
import { randomUUID } from "node:crypto";

import {
  acceptScribeJoinIntent,
  type ScribeJoinIntent,
} from "./message-db.ts";
import { platformForUrl } from "./scribe-monitor.ts";
import type { JoinRequest } from "./scribe-monitor.ts";
import type { BotRecord } from "./store.ts";

export type ScribePlatform = "google_meet" | "zoom" | "teams";

export interface ScribeActor {
  userId: string;
  botId: string;
  threadId: string;
}

/** Notice-sender selection for a terminal capture. The persisted intent
 * triple wins: it is the initiating user's identity, captured at request
 * time. Calendar captures have no intent row and keep the relay service
 * actor; with neither, the caller keeps its existing "unsent" warning
 * instead of inventing an identity. Pure and deterministic. */
export function resolveNoticeSender(
  intent: { ownerUserId: string; botId: string; threadId: string } | null,
  relayActor: ScribeActor | undefined,
): ScribeActor | undefined {
  if (intent) return { userId: intent.ownerUserId, botId: intent.botId, threadId: intent.threadId };
  return relayActor;
}

/** Normalize a meeting URL into an active-session matching key. Purely
 * syntactic (scheme/host/path shape) — destination safety policy (SSRF) is
 * enforced separately at the route, never inferred from this key. */
export function normalizeMeetingUrlKey(platform: ScribePlatform, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes(" ") || host.includes("..")) return null;
  if (platformForUrl(url) !== platform) return null;
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path) path = "/";
  return `${platform}|${host}${path}`;
}

/** Permanent notice-delivery failures must retire loudly instead of
 * retrying forever: a mailbox that is not connected or configured will
 * never heal by waiting. Matches the BFF's stable error texts for the
 * shared-mailbox send path. Everything else (timeouts, refused
 * connections, 5xx) stays transient and retries. */
export function isPermanentNoticeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /mailbox.*not (connected|configured)|not connected for this user|shared mailbox call failed \(404\)/i.test(message);
}

/** The immediate-join permission contract, checked server-side against the
 * verified actor: the asserted bot must exist, carry the Mercury role, and
 * belong to the asserted user. Organizer/invited_by/owner for the descriptor,
 * receipts, and notices all derive from this identity — never from
 * tool-supplied fields. */
export function authorizeScribeJoiner(
  actor: ScribeActor,
  store: { bot(id: string): Pick<BotRecord, "relayAgent" | "ownerUserId"> | null },
): { ok: true } | { ok: false; reason: string } {
  const bot = store.bot(actor.botId);
  if (!bot) return { ok: false, reason: "unknown bot" };
  if (bot.relayAgent !== "mercury") return { ok: false, reason: "scribe join requires Mercury" };
  if (bot.ownerUserId !== actor.userId) return { ok: false, reason: "bot is not owned by the actor" };
  return { ok: true };
}

export interface ManualJoinInput {
  requestKey: string;
  meetingUrl: string;
  platform: ScribePlatform;
  title?: string;
  organizerEmail?: string;
  actor: ScribeActor;
  now?: number;
}

/** Accept a manual join: validate shape, then atomically deduplicate (same
 * request key → original instance), collapse onto a live capture (same room
 * pending/armed → live instance), or create a fresh capture instance.
 * Throws on malformed input; the route maps that to a rejection. */
export function acceptManualJoin(input: ManualJoinInput): {
  outcome: "created" | "duplicate" | "active";
  intent: ScribeJoinIntent;
} {
  const urlKey = normalizeMeetingUrlKey(input.platform, input.meetingUrl);
  if (!urlKey) throw new Error("invalid meeting URL");
  return acceptScribeJoinIntent(
    {
      requestKey: input.requestKey,
      instanceId: randomUUID(),
      source: "manual",
      meetingUrl: input.meetingUrl,
      urlKey,
      platform: input.platform,
      title: input.title,
      organizerEmail: input.organizerEmail,
      ownerUserId: input.actor.userId,
      botId: input.actor.botId,
      threadId: input.actor.threadId,
    },
    input.now ?? Date.now(),
  );
}

/** Manual producer: a pending intent becomes a JoinRequest due immediately.
 * lateAtMs bounds the join window (worker unreachable → terminally
 * unreachable, same as calendar); the synthesized end bounds reconcile,
 * expiring silent workers after the grace window (same as calendar). */
export function joinRequestFromIntent(
  intent: ScribeJoinIntent,
  options: { manualLateMs: number; reconcileGraceMs: number },
): JoinRequest {
  const platform = intent.platform as ScribePlatform;
  return {
    descriptor: {
      instance_id: intent.instanceId,
      platform,
      meeting_url: intent.meetingUrl,
      ...(intent.title ? { title: intent.title } : {}),
    },
    dueAtMs: intent.createdAt,
    lateAtMs: intent.createdAt + options.manualLateMs,
    source: "manual",
    receiptKey: `manual|${intent.instanceId}`,
    event: {
      id: intent.instanceId,
      summary: intent.title ?? undefined,
      end: { dateTime: new Date(intent.createdAt + options.reconcileGraceMs).toISOString() },
      ...(intent.organizerEmail
        ? { organizer: { email: intent.organizerEmail }, creator: { email: intent.organizerEmail } }
        : {}),
    },
  };
}
