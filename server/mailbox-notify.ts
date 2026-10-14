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

/** Set to 0 to disable the notifications entirely. */
function mailboxNotifyEnabled(): boolean {
  return (process.env.RELAY_MAILBOX_NOTIFY?.trim() || "1") !== "0";
}

export async function sendMailboxCompletionEmail(input: {
  capability: string | undefined;
  actor: MailboxActor;
  email: string;
  title: string;
  detail: string;
}): Promise<void> {
  if (!mailboxNotifyEnabled()) return;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return;
  const excerpt = redactSecretsInText(input.detail.trim()).trim().slice(0, 4_000);
  const body = [
    `"${input.title}" finished in Relay.`,
    "",
    excerpt || "Open Relay to see the result.",
    "",
    "Open Relay to see the full thread.",
  ].join("\n");
  await mailboxBffCall(input.capability, "/api/internal/gmail/send", {
    to: [input.email],
    subject: `Relay: ${input.title} finished`.slice(0, 250),
    body,
    mailbox: "relay",
  }, input.actor);
}
