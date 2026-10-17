// "Finished while you were away" notices for the shared mailbox. When a
// routed turn settles with real work (not a NO_ACTION acknowledgement), the
// teammate who sent the mail gets one short email from Relay's own account,
// with a bounded excerpt; the full thread lives in Relay. Server-only: this
// is never a model-callable tool, and it is addressed only to the verified
// sender already recorded on the conversation.
import { mailboxBffCall, type MailboxActor } from "./mailbox-bff.ts";
import { redactSecretsInText } from "./redact.ts";

/** A reply that asks for nothing (an invitation's NO_ACTION, possibly wrapped
 * in Markdown emphasis) must not trigger a completion email. */
export function mailboxReplyNeedsNoEmail(reply: string | undefined): boolean {
  return /^\s*[*_`#>\s]*NO_ACTION\b/i.test(reply ?? "");
}

/** Whether a settled routed-mail turn should email its sender now. The turn
 * that delegates to a teammate and settles waiting is not the end of the
 * work: it is skipped, and the resumed turn — the one that truly answers —
 * sends the mail, once. A no-op reply and a failed turn are never worth one. */
export function shouldSendMailboxCompletion(input: {
  routed: boolean;
  ok: boolean;
  alreadySent: boolean;
  awaitingTeammates: boolean;
  reply: string | undefined;
}): boolean {
  if (!input.routed || !input.ok || input.alreadySent || input.awaitingTeammates) return false;
  const detail = input.reply?.trim();
  return Boolean(detail) && !mailboxReplyNeedsNoEmail(detail);
}

/** Set to 0 to disable the notifications entirely. */
function mailboxNotifyEnabled(): boolean {
  return (process.env.RELAY_MAILBOX_NOTIFY?.trim() || "1") !== "0";
}

/** The subject to reply under, before any answer exists (the receipt email):
 * the sender's own subject, else the first meaningful line of their request,
 * else undefined so the caller falls back to a plain line. */
export function deriveMailSubject(subject: string | undefined, body: string | undefined): string | undefined {
  const trimmed = subject?.trim();
  if (trimmed) return trimmed.slice(0, 250);
  const line = (body ?? "").split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  if (!line) return undefined;
  return line.replace(/^subject\s*:\s*/i, "").slice(0, 120) || undefined;
}

/** A reply's subject, from the mail it answers: the same thread, prefixed
 * once. With no subject to reply to, a plain, honest line rather than a
 * status claim the body may not support. */
export function mailboxReplySubject(subject: string | undefined): string {
  const trimmed = subject?.trim();
  if (!trimmed) return "Your Relay request";
  return /^re:/i.test(trimmed) ? trimmed.slice(0, 250) : `Re: ${trimmed}`.slice(0, 250);
}

/** A short acknowledgement that Relay has the mail and is on it, sent the
 * moment a message is routed — distinct from the completion email, which
 * carries the result. Kept separate so a long task still answers the sender
 * immediately instead of staying silent until it finishes. */
export async function sendMailboxAcknowledgement(input: {
  capability: string | undefined;
  actor: MailboxActor;
  email: string;
  /** The subject of the mail being acknowledged, if any. */
  subject?: string;
}): Promise<void> {
  if (!mailboxNotifyEnabled()) return;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return;
  await mailboxBffCall(input.capability, "/api/internal/gmail/send", {
    to: [input.email],
    subject: mailboxReplySubject(input.subject),
    body: "Relay received your email and is working on it. You will get a follow-up with the result.\n",
    mailbox: "relay",
  }, input.actor);
}

export async function sendMailboxCompletionEmail(input: {
  capability: string | undefined;
  actor: MailboxActor;
  email: string;
  /** The subject of the mail being answered, if any. */
  subject?: string;
  detail: string;
  /** Relay's public address, so the reply can link back to the full thread.
   * Omitted when this server has no public URL. */
  relayUrl?: string;
  /** Files the turn produced (a report, a document). Sent with the reply so a
   * long deliverable reaches the teammate as an attachment, not pasted text. */
  attachments?: ReadonlyArray<{ filename: string; mimeType: string; data: string }>;
}): Promise<void> {
  if (!mailboxNotifyEnabled()) return;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return;
  const excerpt = redactSecretsInText(input.detail.trim()).trim().slice(0, 4_000);
  const body = [
    excerpt || "Open Relay to see the result.",
    ...(input.relayUrl ? ["", `Open Relay to see the full thread: ${input.relayUrl}`] : []),
  ].join("\n");
  await mailboxBffCall(input.capability, "/api/internal/gmail/send", {
    to: [input.email],
    subject: mailboxReplySubject(input.subject),
    body,
    mailbox: "relay",
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  }, input.actor);
}
