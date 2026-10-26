/** Attachment refs that ride a routed reply.
 *
 * The lookup is intentionally thread-agnostic: a delegated child thread is not
 * itself a routed-mail thread, but the artifacts it attached in its completing
 * turn still belong to the parent reply. The caller supplies the messages and
 * the attachment store root; nothing here decides whether a thread is routed.
 */
import { resolve, sep } from "node:path";

export interface MailAttachmentRef {
  path: string;
  filename: string;
  mimeType: string;
}

export interface MailAttachmentMessage {
  turnId?: string;
  attachments?: ReadonlyArray<{
    kind: string;
    path: string;
    name?: string;
    mime: string;
  }>;
}

export const MAX_MAIL_ATTACHMENTS = 10;
export const MAX_MAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MAIL_TOTAL_BYTES = 25 * 1024 * 1024;

/** Explicit file attachments from one turn, confined to the attachment
 * store. Size and total checks live in the outbox drain so every
 * deterministic drop is disclosed in the sent reply. */
export function mailAttachmentRefsForTurn(
  messages: Iterable<MailAttachmentMessage>,
  turnId: string,
  attachmentsDir: string,
): MailAttachmentRef[] {
  const out: MailAttachmentRef[] = [];
  const attachmentsRoot = `${resolve(attachmentsDir)}${sep}`;
  for (const message of messages) {
    if (message.turnId !== turnId) continue;
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "file") continue;
      const resolved = resolve(attachment.path);
      if (!resolved.startsWith(attachmentsRoot)) continue;
      out.push({
        path: resolved,
        filename: attachment.name?.trim() || resolved.split(/[\\/]/).pop() || "attachment",
        mimeType: attachment.mime,
      });
    }
  }
  return out;
}

/** Merge parent-turn and delegated-turn artifacts for one reply. Delegated
 * refs come back through a persisted receipt, so containment and dedup are
 * re-applied here; size and total checks live in the outbox drain. */
export function mergeMailAttachmentRefs(
  groups: ReadonlyArray<ReadonlyArray<MailAttachmentRef>>,
  attachmentsDir: string,
): MailAttachmentRef[] {
  const out: MailAttachmentRef[] = [];
  const seen = new Set<string>();
  const attachmentsRoot = `${resolve(attachmentsDir)}${sep}`;
  for (const group of groups) {
    for (const ref of group) {
      const resolved = resolve(ref.path);
      if (!resolved.startsWith(attachmentsRoot) || seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ path: resolved, filename: ref.filename, mimeType: ref.mimeType });
    }
  }
  return out;
}
