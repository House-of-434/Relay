import { createHash, createHmac } from "node:crypto";

export const MAIL_APPROVAL_PURPOSE = "relay-mail-approval";
export const MAIL_APPROVAL_TTL_SECONDS = 5 * 60;

export interface MailApprovalDraft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: Array<
    | { filename: string; mimeType: string; data: string }
    | { messageId: string; attachmentId: string }
  >;
}

export interface MailApprovalReceipt {
  botId: string;
  threadId: string;
  draftHash: string;
  nonce: string;
  expiry: number;
  signature: string;
}

function canonicalAttachments(
  attachments: MailApprovalDraft["attachments"],
): Array<Record<string, string>> {
  return (attachments ?? []).map((entry) =>
    "filename" in entry
      ? { filename: entry.filename, mimeType: entry.mimeType, data: entry.data } as Record<string, string>
      : { messageId: entry.messageId, attachmentId: entry.attachmentId } as Record<string, string>,
  );
}

export function computeDraftHash(draft: MailApprovalDraft): string {
  const canonical = JSON.stringify([
    draft.to,
    draft.cc ?? [],
    draft.bcc ?? [],
    draft.subject,
    draft.body,
    canonicalAttachments(draft.attachments),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function signingBytes(receipt: Omit<MailApprovalReceipt, "signature">): string {
  return JSON.stringify([
    MAIL_APPROVAL_PURPOSE,
    receipt.botId,
    receipt.threadId,
    receipt.draftHash,
    receipt.nonce,
    receipt.expiry,
  ]);
}

export function signMailApprovalReceipt(
  input: { botId: string; threadId: string; draft: MailApprovalDraft; nonce: string; expiry: number },
  secret: string | undefined,
): MailApprovalReceipt {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("mail approval secret is not configured");
  }
  const draftHash = computeDraftHash(input.draft);
  const signature = createHmac("sha256", secret)
    .update(signingBytes({ botId: input.botId, threadId: input.threadId, draftHash, nonce: input.nonce, expiry: input.expiry }))
    .digest("base64url");
  return {
    botId: input.botId,
    threadId: input.threadId,
    draftHash,
    nonce: input.nonce,
    expiry: input.expiry,
    signature,
  };
}
