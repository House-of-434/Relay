// "Finished while you were away" notices for the shared mailbox. When a
// routed turn settles with real work (not a NO_ACTION acknowledgement), the
// teammate who sent the mail gets one short email from Relay's own account,
// with a bounded excerpt; the full thread lives in Relay. Server-only: this
// is never a model-callable tool, and it is addressed only to the verified
// sender already recorded on the conversation.
import { createHash } from "node:crypto";

import { fromMarkdown } from "mdast-util-from-markdown";

import { mailboxBffCall, type MailboxActor } from "./mailbox-bff.ts";
import { redactSecretsInText } from "./redact.ts";

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

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
}

/** Render markdown to readable plain text for the notification email. Email
 * bodies are plain text, so emphasis markers and link syntax must not leak
 * through as literal `*`. Uses the mdast parser already in the tree — no new
 * dependency: emphasis is flattened, a link keeps its text and URL, lists keep
 * their bullets, code keeps its content, and raw HTML is dropped. */
export function markdownToPlainText(markdown: string): string {
  const tree = fromMarkdown(markdown) as unknown as MdNode;
  const out: string[] = [];

  const textOf = (node: MdNode): string => {
    let value = "";
    const collect = (current: MdNode): void => {
      if (current.type === "text" && current.value) value += current.value;
      for (const child of current.children ?? []) collect(child);
    };
    collect(node);
    return value;
  };

  const walk = (node: MdNode, listDepth: number): void => {
    switch (node.type) {
      case "text":
      case "inlineCode":
      case "code":
        out.push(node.value ?? "");
        return;
      case "break":
        out.push("\n");
        return;
      case "emphasis":
      case "strong":
      case "delete":
      case "linkReference":
        for (const child of node.children ?? []) walk(child, listDepth);
        return;
      case "link": {
        const label = textOf(node);
        for (const child of node.children ?? []) walk(child, listDepth);
        // Keep the target when it is not already the visible text.
        if (node.url && node.url !== label.trim()) out.push(` (${node.url})`);
        return;
      }
      case "image":
        out.push(node.alt ? `[image: ${node.alt}]` : "[image]");
        return;
      case "listItem": {
        // Gather the item's own text, then prefix it with one bullet so items
        // stay on consecutive lines instead of gaining a blank line each.
        const start = out.length;
        for (const child of node.children ?? []) walk(child, listDepth + 1);
        const body = out.splice(start).join("").trim();
        out.push(`\n${"  ".repeat(listDepth)}- ${body}`);
        return;
      }
      case "paragraph":
      case "heading":
        for (const child of node.children ?? []) walk(child, listDepth);
        out.push("\n\n");
        return;
      case "list":
      case "blockquote":
        for (const child of node.children ?? []) walk(child, listDepth);
        out.push("\n");
        return;
      case "thematicBreak":
        out.push("---\n");
        return;
      case "html":
        return; // no raw HTML in a plain-text email
      default:
        for (const child of node.children ?? []) walk(child, listDepth);
    }
  };

  walk(tree, 0);
  return out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A reply that asks for nothing (an invitation's NO_ACTION, possibly wrapped
 * in Markdown emphasis) must not trigger a completion email. */
export function mailboxReplyNeedsNoEmail(reply: string | undefined): boolean {
  return /^\s*[*_`#>\s]*NO_ACTION\b/i.test(reply ?? "");
}

/** Whether a settled routed-mail turn should email its sender now. The turn
 * that delegates to a teammate and settles waiting is not the end of the
 * work: it is skipped, and the resumed turn — the one that truly answers —
 * sends the mail, once. A no-op reply and a failed turn are never worth one. */
/** Set to 0 to disable the notifications entirely. */
function mailboxNotifyEnabled(): boolean {
  return (process.env.RELAY_MAILBOX_NOTIFY?.trim() || "1") !== "0";
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

/** A short acknowledgement that Relay has the mail and is on it, sent the
 * moment a message is routed — distinct from the completion email, which
 * carries the result. Kept separate so a long task still answers the sender
 * immediately instead of staying silent until it finishes. */
export async function sendMailboxAcknowledgement(input: {
  capability: string | undefined;
  mirrorCapability: string | undefined;
  actor: MailboxActor;
  email: string;
  /** The subject of the mail being acknowledged, if any. */
  subject?: string;
  gmailThreadId: string;
  sourceMessageId: string;
}): Promise<MailSendIds | null> {
  if (!mailboxNotifyEnabled()) return null;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return null;
  return sendMailboxReply({
    capability: input.capability,
    mirrorCapability: input.mirrorCapability,
    actor: input.actor,
    to: input.email,
    subject: mailboxReplySubject(input.subject),
    body: "Relay received your email and is working on it. You will get a follow-up with the result.\n",
    gmailThreadId: input.gmailThreadId,
    sourceMessageId: input.sourceMessageId,
  });
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
    gmailThreadId: input.gmailThreadId,
    sourceMessageId: input.sourceMessageId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  }, input.actor, input.mirrorCapability);
  return sentIdsOf(response);
}
