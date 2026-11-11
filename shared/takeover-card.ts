/**
 * Browser-takeover cards: a typed purpose on the credential-card lifecycle.
 *
 * The card carries only safe metadata (session identity, title, status). The
 * viewer token lives in the browser's memory after an authenticated mint and
 * is never stored in a message, a transcript line, or model-visible output.
 *
 * Only Done resumes the agent. Dismiss and expiry release the browser and stop
 * the task; the person's next message is a normal turn.
 */
import type { TakeoverCardData } from "./wire.ts";

export function takeoverPending(card: TakeoverCardData | undefined): boolean {
  return card?.kind === "browser_takeover" && card.status === "pending";
}
