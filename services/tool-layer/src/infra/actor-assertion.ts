import { createHmac, timingSafeEqual } from "node:crypto";

export const ACTOR_ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

/** Fixed HMAC input prefix: a signature made for this purpose cannot be
 * replayed as a signature for another. Must match the harness and BFF. */
export const ACTOR_ASSERTION_PURPOSE = "relay-actor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = "botId,issuedAt,signature,threadId,userId";

export type RelayActorAssertion = {
  userId: string;
  botId: string;
  threadId: string;
  issuedAt: number;
  signature: string;
};

export type RelayActorContext = Omit<RelayActorAssertion, "signature">;

function signingBytes(userId: string, issuedAt: number, botId: string, threadId: string): string {
  return JSON.stringify([ACTOR_ASSERTION_PURPOSE, userId, issuedAt, botId, threadId]);
}

function secretKey(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export function signActorAssertion(
  actor: { userId: string; botId: string; threadId: string },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const userId = actor.userId.trim().toLowerCase();
  const botId = actor.botId.trim().toLowerCase();
  const threadId = actor.threadId.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay actor user id must be a UUID");
  if (!UUID.test(botId)) throw new Error("Relay actor bot id must be a UUID");
  if (!UUID.test(threadId)) throw new Error("Relay actor thread id must be a UUID");
  if (!Number.isSafeInteger(issuedAt)) throw new Error("Relay actor assertion timestamp is invalid");

  const signature = createHmac("sha256", secretKey(secret))
    .update(signingBytes(userId, issuedAt, botId, threadId))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId, threadId, signature });
}

export function verifyActorAssertion(
  value: string,
  secret: string | undefined,
  now = Date.now(),
): RelayActorContext {
  if (value.length > 2048) throw new Error("actor assertion is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("actor assertion is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("actor assertion is invalid");
  }

  const assertion = parsed as Record<string, unknown>;
  const keys = Object.keys(assertion).sort().join(",");
  if (keys !== KEYS ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.botId !== "string" || !UUID.test(assertion.botId) ||
      typeof assertion.threadId !== "string" || !UUID.test(assertion.threadId) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new Error("actor assertion is invalid");
  }

  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - assertion.issuedAt) > ACTOR_ASSERTION_MAX_SKEW_SECONDS) {
    throw new Error("actor assertion is expired or outside allowed clock skew");
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signingBytes(assertion.userId, assertion.issuedAt, assertion.botId, assertion.threadId))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("actor assertion signature is invalid");
  }

  return {
    userId: assertion.userId,
    botId: assertion.botId,
    threadId: assertion.threadId,
    issuedAt: assertion.issuedAt,
  };
}
