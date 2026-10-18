// "Finished while you were away" notices for the shared mailbox. When a
// routed turn settles with real work (not a NO_ACTION acknowledgement), the
// teammate who sent the mail gets one short email from Relay's own account,
// with a bounded excerpt; the full thread lives in Relay. Server-only: this
// is never a model-callable tool, and it is addressed only to the verified
// sender already recorded on the conversation.
import { fromMarkdown } from "mdast-util-from-markdown";

import { mailboxBffCall, type MailboxActor } from "./mailbox-bff.ts";
import { redactSecretsInText } from "./redact.ts";

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

/** A question the turn needs answered, delivered to an email sender who
 * cannot use Relay's in-app card. Framed as the reply to their message so it
 * threads, with the choices listed when the agent offered any. The sender
 * answers by replying; that reply starts the next step. */
export async function sendMailboxQuestionEmail(input: {
  capability: string | undefined;
  actor: MailboxActor;
  email: string;
  /** The subject of the mail being answered, if any. */
  subject?: string;
  question: string;
  /** Suggested answers the agent offered, as one-tap options in-app. */
  choices?: readonly string[];
  /** Relay's public address, so the reply can link back to the full thread. */
  relayUrl?: string;
}): Promise<void> {
  if (!mailboxNotifyEnabled()) return;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return;
  const question = markdownToPlainText(redactSecretsInText(input.question.trim())).trim().slice(0, 4_000);
  const choices = (input.choices ?? []).map((choice) => `- ${choice.trim()}`).filter((line) => line.length > 2);
  const body = [
    "Relay needs one thing before it can finish your request:",
    "",
    question || "It needs more information.",
    ...(choices.length ? ["", "Suggested answers:", ...choices] : []),
    "",
    "Reply to this email with your answer.",
    ...(input.relayUrl ? ["", `Open Relay to see the full thread: ${input.relayUrl}`] : []),
  ].join("\n");
  await mailboxBffCall(input.capability, "/api/internal/gmail/send", {
    to: [input.email],
    subject: mailboxReplySubject(input.subject),
    body,
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
  const excerpt = markdownToPlainText(redactSecretsInText(input.detail.trim())).trim().slice(0, 4_000);
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
