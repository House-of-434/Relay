import { createHmac, timingSafeEqual } from "node:crypto";

export const PUBLISH_AUTH_PURPOSE = "relay-github-publish";

export interface PublishAttachment {
  fileId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  path: string;
}

export interface PublishAuthorization {
  version: 1;
  userId: string;
  botId: string;
  threadId: string;
  agent: "scout";
  repo: string;
  path: string;
  branch: string;
  commit: string;
  title: string;
  body: string;
  attachments: PublishAttachment[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^relay\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const FILE_ID = /^file_[a-z0-9]{6,32}$/;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function signingBytes(value: Omit<PublishAuthorization, "signature">): string {
  return JSON.stringify([
    PUBLISH_AUTH_PURPOSE,
    value.version,
    value.userId,
    value.botId,
    value.threadId,
    value.agent,
    value.repo,
    value.path,
    value.branch,
    value.commit,
    value.title,
    value.body,
    value.attachments.map((attachment) => [
      attachment.fileId,
      attachment.name,
      attachment.mime,
      attachment.bytes,
      attachment.sha256,
      attachment.path,
    ]),
    value.nonce,
    value.issuedAt,
    value.expiresAt,
  ]);
}

export function signPublishAuthorization(
  value: Omit<PublishAuthorization, "version" | "signature">,
  secret: string,
): PublishAuthorization {
  if (Buffer.byteLength(secret) < 32) throw new Error("publish authorization secret is not configured");
  const payload = { version: 1 as const, ...value };
  const signature = createHmac("sha256", secret).update(signingBytes(payload)).digest("base64url");
  return { ...payload, signature };
}

function validAttachments(value: unknown): value is PublishAttachment[] {
  if (!Array.isArray(value) || value.length > 12) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const attachment = entry as Partial<PublishAttachment>;
    return (
      typeof attachment.fileId === "string" && FILE_ID.test(attachment.fileId) &&
      typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 255 &&
      !attachment.name.includes("/") && !attachment.name.includes("\\") &&
      typeof attachment.mime === "string" && MIME.test(attachment.mime) &&
      typeof attachment.bytes === "number" && Number.isSafeInteger(attachment.bytes) &&
      attachment.bytes > 0 && attachment.bytes <= MAX_ATTACHMENT_BYTES &&
      typeof attachment.sha256 === "string" && SHA256.test(attachment.sha256) &&
      typeof attachment.path === "string" && attachment.path.length > 0 && attachment.path.length <= 4096
    );
  });
}

export function verifyPublishAuthorization(
  value: unknown,
  secret: string | undefined,
  now = Date.now(),
): PublishAuthorization {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("publish authorization secret is not configured");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid publish authorization");
  const auth = value as Partial<PublishAuthorization>;
  if (
    auth.version !== 1 ||
    typeof auth.userId !== "string" || !UUID.test(auth.userId) ||
    typeof auth.botId !== "string" || !UUID.test(auth.botId) ||
    typeof auth.threadId !== "string" || !UUID.test(auth.threadId) ||
    auth.agent !== "scout" ||
    typeof auth.repo !== "string" || !REPO.test(auth.repo) ||
    typeof auth.path !== "string" || auth.path.length < 1 || auth.path.length > 512 ||
    typeof auth.branch !== "string" || !BRANCH.test(auth.branch) || auth.branch.split("/").includes("..") ||
    typeof auth.commit !== "string" || !COMMIT.test(auth.commit) ||
    typeof auth.title !== "string" || auth.title.trim().length < 1 || auth.title.length > 256 ||
    typeof auth.body !== "string" || auth.body.length > 24_000 ||
    !validAttachments(auth.attachments) ||
    typeof auth.nonce !== "string" || !NONCE.test(auth.nonce) ||
    typeof auth.issuedAt !== "number" || !Number.isSafeInteger(auth.issuedAt) ||
    typeof auth.expiresAt !== "number" || !Number.isSafeInteger(auth.expiresAt) ||
    typeof auth.signature !== "string" || !SIGNATURE.test(auth.signature)
  ) {
    throw new Error("invalid publish authorization");
  }
  const nowSeconds = Math.floor(now / 1000);
  if (auth.expiresAt <= nowSeconds || auth.issuedAt > nowSeconds + 60) throw new Error("publish authorization expired");
  const expected = createHmac("sha256", secret).update(signingBytes(auth as Omit<PublishAuthorization, "signature">)).digest();
  const received = Buffer.from(auth.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("publish authorization signature is invalid");
  }
  return auth as PublishAuthorization;
}

/** Git smart HTTP uses Basic auth with the `x-access-token` username, not the
 * REST API's Bearer header. */
export function gitReadAuthorization(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}
