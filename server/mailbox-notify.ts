// Routed reply and question email delivery for the shared mailbox. Relayed
// replies are rendered as email (HTML plus a plain-text alternative) and sent
// from Relay's own account to the verified sender. Server-only: this is never
// a model-callable tool.
import { createHash } from "node:crypto";

import { markdownToPlainText } from "./email-markdown.ts";
import { mailboxBffCall, type MailboxActor } from "./mailbox-bff.ts";
import { redactSecretsInText } from "./redact.ts";

export { markdownToPlainText } from "./email-markdown.ts";

/** Durable receipt payload for record-then-send mailbox emails. A claim is
 * written before the Gmail send; on success it is overwritten with the sent
 * result. A stale claim (crash between claim and send) is retryable; a sent
 * receipt suppresses every later attempt. */
export interface MailSendReceipt {
  state: "claimed" | "sent";
  at: number;
  /** Hash of the exact recipients + body sent, so a retry sends the same
   * mail rather than a drifted one. */
  fp: string;
  sentId?: string | null;
  gmailThreadId?: string | null;
}

/** Claims older than this with no sent result are treated as crashed
 * attempts and may be retried, rather than suppressing forever. Sends here
 * are a local hop plus a Gmail API call, so a minute comfortably covers an
 * in-flight send; an in-process send is also protected by the memory sets,
 * so this window only governs recovery after a crash. */
export const MAIL_SEND_CLAIM_TTL_MS = 60 * 1000;

/** Hash of the exact mail content, so a retried send is provably the same
 * mail the claim was written for. */
export function mailSendFingerprint(parts: ReadonlyArray<string | undefined>): string {
  return createHash("sha256").update(parts.map((part) => part ?? "").join("\n")).digest("hex");
}

/** True when a stored receipt proves the mail went out. Accepts the legacy
 * bare-`true` receipts written before record-then-send existed. */
export function mailSendReceiptSent(result: unknown): boolean {
  if (result === true) return true;
  return typeof result === "object" && result !== null
    && (result as { state?: unknown }).state === "sent";
}

/** True when a stored receipt is an unexpired claim from an in-flight or
 * recently-crashed send: skip this tick, retry once it goes stale. */
export function mailSendClaimFresh(result: unknown, nowMs: number): boolean {
  if (typeof result !== "object" || result === null) return false;
  const receipt = result as { state?: unknown; at?: unknown };
  return receipt.state === "claimed"
    && typeof receipt.at === "number"
    && nowMs - receipt.at < MAIL_SEND_CLAIM_TTL_MS;
}

/** Gmail send ids from the BFF send route, for the receipt. Null when the
 * send was never attempted (notifications off, mailbox unconfigured). */
export interface MailSendIds {
  sentId: string | null;
  gmailThreadId: string | null;
}

function sentIdsOf(response: unknown): MailSendIds {
  const sent = (response as { sent?: unknown }).sent as { id?: unknown; threadId?: unknown } | undefined;
  return {
    sentId: typeof sent?.id === "string" ? sent.id : null,
    gmailThreadId: typeof sent?.threadId === "string" ? sent.threadId : null,
  };
}

/** A reply that asks for nothing (an invitation's NO_ACTION, possibly wrapped
 * in Markdown emphasis) must not trigger a completion email. */
export function mailboxReplyNeedsNoEmail(reply: string | undefined): boolean {
  return /^\s*[*_`#>\s]*NO_ACTION\b/i.test(reply ?? "");
}

/** Each eligible unattended parent turn is mirrored independently, including
 * a delegation-start turn and a resumed-report turn when each produces an
 * eligible terminal response. */
/** Set to 0 to disable the notifications entirely. */
function mailboxNotifyEnabled(): boolean {
  return (process.env.RELAY_MAILBOX_NOTIFY?.trim() || "1") !== "0";
}

export function describeMailboxSendSkip(): { reason: string; permanent: boolean } {
  if (!mailboxNotifyEnabled()) return { reason: "mailbox notifications disabled", permanent: true };
  return { reason: "shared mailbox is not configured", permanent: false };
}

/** Whether the question email can be delivered right now: notifications
 * enabled and the shared mailbox configured. */
export function canSendMailboxEmail(): boolean {
  return mailboxNotifyEnabled()
    && Boolean(process.env.RELAY_MAILBOX_ADDRESS?.trim() && process.env.RELAY_MAILBOX_USER_ID?.trim());
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

/** A question the turn needs answered, delivered to an email sender who
 * cannot use Relay's in-app card. Framed as the reply to their message so it
 * threads, with the choices listed when the agent offered any. The sender
 * answers by replying; that reply starts the next step. */
export async function sendMailboxQuestionEmail(input: {
  capability: string | undefined;
  mirrorCapability: string | undefined;
  actor: MailboxActor;
  email: string;
  /** The subject of the mail being answered, if any. */
  subject?: string;
  question: string;
  /** Suggested answers the agent offered, as one-tap options in-app. */
  choices?: readonly string[];
  /** Relay's public address, so the reply can link back to the full thread. */
  relayUrl?: string;
  gmailThreadId: string;
  sourceMessageId: string;
}): Promise<MailSendIds | null> {
  if (!canSendMailboxEmail()) return null;
  const question = markdownToPlainText(redactSecretsInText(input.question.trim())).trim().slice(0, 4_000);
  const choices = (input.choices ?? []).map((choice) => `- ${markdownToPlainText(redactSecretsInText(choice)).replace(/\s+/g, " ").trim()}`).filter((line) => line.length > 2);
  const body = [
    "Relay needs one thing before it can finish your request:",
    "",
    question || "It needs more information.",
    ...(choices.length ? ["", "Suggested answers:", ...choices] : []),
    "",
    "Reply to this email with your answer.",
    ...(input.relayUrl ? ["", `Open Relay to see the full thread: ${input.relayUrl}`] : []),
  ].join("\n");
  return sendMailboxReply({
    capability: input.capability,
    mirrorCapability: input.mirrorCapability,
    actor: input.actor,
    to: input.email,
    subject: mailboxReplySubject(input.subject),
    body,
    gmailThreadId: input.gmailThreadId,
    sourceMessageId: input.sourceMessageId,
  });
}

export async function sendMailboxReply(input: {
  capability: string | undefined;
  mirrorCapability: string | undefined;
  actor: MailboxActor;
  to: string;
  subject: string;
  body: string;
  /** Rendered HTML alternative for routed replies. Questions omit it. */
  html?: string;
  gmailThreadId: string;
  sourceMessageId: string;
  /** Persisted deterministic RFC Message-ID for outbox reconciliation. */
  messageId?: string;
  attachments?: ReadonlyArray<{ filename: string; mimeType: string; data: string }>;
}): Promise<MailSendIds | null> {
  if (!mailboxNotifyEnabled()) return null;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return null;
  const response = await mailboxBffCall<unknown>(input.capability, "/api/internal/gmail/reply", {
    to: [input.to],
    subject: input.subject,
    body: input.body,
    ...(input.html ? { html: input.html } : {}),
    gmailThreadId: input.gmailThreadId,
    sourceMessageId: input.sourceMessageId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  }, input.actor, input.mirrorCapability);
  return sentIdsOf(response);
}
