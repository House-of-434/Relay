import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { RelayActor } from "./actor-assertion.ts";

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

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

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

const usedNonces = new Map<string, number>();

export function __resetMailApprovalNoncesForTests(): void {
  usedNonces.clear();
}

function prune(nowSeconds: number): void {
  for (const [nonce, expiry] of usedNonces) {
    if (expiry <= nowSeconds) usedNonces.delete(nonce);
  }
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

export type MailApprovalVerdict = { ok: true } | { ok: false; error: string };

export function verifyMailApprovalReceipt(
  receipt: MailApprovalReceipt,
  draft: MailApprovalDraft,
  actor: RelayActor,
  secret: string | undefined,
  nowSeconds: number,
): MailApprovalVerdict {
  if (!secret || Buffer.byteLength(secret) < 32) {
    return { ok: false, error: "mail approval is not configured" };
  }
  if (
    !NONCE.test(receipt.nonce) ||
    !HEX64.test(receipt.draftHash) ||
    !SIGNATURE.test(receipt.signature) ||
    !Number.isSafeInteger(receipt.expiry)
  ) {
    return { ok: false, error: "mail approval receipt is invalid" };
  }
  if (receipt.botId !== actor.botId || receipt.threadId !== actor.threadId) {
    return { ok: false, error: "mail approval receipt does not match this conversation" };
  }
  if (receipt.expiry < nowSeconds) {
    return { ok: false, error: "mail approval receipt is expired" };
  }
  const expectedHash = computeDraftHash(draft);
  if (receipt.draftHash !== expectedHash) {
    return { ok: false, error: "mail approval receipt does not match this draft; any draft change needs a new confirmation" };
  }
  const expected = createHmac("sha256", secret).update(signingBytes(receipt)).digest();
  const received = Buffer.from(receipt.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, error: "mail approval receipt signature is invalid" };
  }
  prune(nowSeconds);
  if (usedNonces.has(receipt.nonce)) {
    return { ok: false, error: "mail approval receipt was already used" };
  }
  usedNonces.set(receipt.nonce, receipt.expiry);
  return { ok: true };
}
