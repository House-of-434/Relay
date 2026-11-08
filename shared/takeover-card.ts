/**
 * Browser-takeover cards: a typed purpose on the credential-card lifecycle.
 *
 * The card carries only safe metadata (session identity, title, status). The
 * viewer token lives in the browser's memory after an authenticated mint and
 * is never stored in a message, a transcript line, or model-visible output.
 */
import type { TakeoverCardData, WireMessage } from "./wire.ts";

export function takeoverPending(card: TakeoverCardData | undefined): boolean {
  return card?.kind === "browser_takeover" && card.status === "pending";
}

/** The outcome a terminal takeover reports to the continuation machinery.
 * Done is the positive outcome; Dismiss and Expiry both resume the agent as
 * a declined intervention so it can report the block honestly. */
export function takeoverResumeOutcome(
  status: TakeoverCardData["status"],
): "provided" | "dismissed" | null {
  if (status === "done") return "provided";
  if (status === "dismissed" || status === "expired") return "dismissed";
  return null;
}

/** A still-pending takeover card for this request key / bot. Superseded
 * cards keep their terminal state untouched. */
export function isPendingTakeoverRequest(
  message: Pick<WireMessage, "kind" | "takeover" | "from">,
  requestKey: string,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "takeover" &&
    message.takeover?.kind === "browser_takeover" &&
    message.takeover.requestKey === requestKey &&
    message.takeover.status === "pending" &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}
