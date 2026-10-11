/** Scribe notices: the fixed email templates and the capability-gated send.
 *
 * The monitor decides WHAT happened (kind, reason, signed-out); the harness
 * decides WHO hears it. The templates are pure and tested; the send reuses the
 * mailbox transport. No model call.
 */
import { mailboxBffCall } from "./mailbox-bff.ts";
import { redactSecretsInText } from "./redact.ts";
import type { ScribeNotice } from "./scribe-monitor.ts";

export interface ScribeEmail {
  subject: string;
  body: string;
}

/** `(2026-10-11)` suffix from a scheduled_end, or "" when absent. */
function whenLabel(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ` (${new Date(ms).toISOString().slice(0, 10)})` : "";
}

/** The organizer's notice: ready on completed/partial, otherwise a plain
 *  "couldn't join" (never the re-authentication instruction — they cannot act
 *  on it). */
export function scribeOrganizerEmail(notice: ScribeNotice): ScribeEmail {
  const title = notice.title?.trim() || "the meeting";
  const when = whenLabel(notice.scheduled_end);
  if (notice.kind === "completed") {
    return { subject: `Transcript ready: ${title}`, body: `The transcript for "${title}"${when} is ready in Relay.` };
  }
  const reason = notice.reason?.trim() || "Relay could not join the meeting";
  return { subject: `Relay couldn't join: ${title}`, body: `Relay couldn't join "${title}"${when}: ${reason}.` };
}

/** The admin re-authentication instruction (signed-out case only). */
export function scribeAdminEmail(): ScribeEmail {
  return {
    subject: "Relay Scribe needs re-authentication",
    body:
      "Relay Scribe's browser profile is signed out, so recent meetings could not be transcribed. " +
      "Re-run the one-time relay@ login on the worker host (see plans/scribe-stt.md §7).",
  };
}

/** Parse the admin allow-list. Validation against known members happens in the
 *  harness (a configured address nobody owns is dropped there). */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    if (email.includes("@")) out.add(email);
  }
  return [...out];
}

export function scribeNotifyEnabled(): boolean {
  return (process.env.RELAY_MAILBOX_NOTIFY?.trim() || "1") !== "0";
}

/** Send one notice email from relay@ via the capability-gated mailbox route.
 *  Kill-switched by RELAY_MAILBOX_NOTIFY; secrets redacted, body bounded. */
export async function sendScribeEmail(capability: string | undefined, email: string, message: ScribeEmail): Promise<void> {
  if (!scribeNotifyEnabled()) return;
  if (!process.env.RELAY_MAILBOX_ADDRESS?.trim() || !process.env.RELAY_MAILBOX_USER_ID?.trim()) return;
  await mailboxBffCall(capability, "/api/internal/gmail/send", {
    to: [email],
    subject: message.subject.slice(0, 250),
    body: redactSecretsInText(message.body.trim()).slice(0, 4_000),
    mailbox: "relay",
  });
}
