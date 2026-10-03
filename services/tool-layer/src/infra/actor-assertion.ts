import { createHmac, timingSafeEqual } from "node:crypto";

export const ACTOR_ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export type RelayActorAssertion = {
  userId: string;
  email: string;
  issuedAt: number;
  signature: string;
};

function signingBytes(userId: string, email: string, issuedAt: number): string {
  return JSON.stringify([userId, email, issuedAt]);
}

function secretKey(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export function signActorAssertion(
  actor: { userId: string; email: string },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const userId = actor.userId.trim();
  const email = actor.email.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay actor user id must be a UUID");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Relay actor email metadata is invalid");
  if (!Number.isSafeInteger(issuedAt)) throw new Error("Relay actor assertion timestamp is invalid");

  const signature = createHmac("sha256", secretKey(secret))
    .update(signingBytes(userId, email, issuedAt))
    .digest("base64url");
  return JSON.stringify({ userId, email, issuedAt, signature });
}

export function verifyActorAssertion(
  value: string,
  secret: string | undefined,
  now = Date.now(),
): Omit<RelayActorAssertion, "signature"> {
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
  if (Object.keys(assertion).sort().join(",") !== "email,issuedAt,signature,userId" ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.email !== "string" || assertion.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assertion.email) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new Error("actor assertion is invalid");
  }

  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - assertion.issuedAt) > ACTOR_ASSERTION_MAX_SKEW_SECONDS) {
    throw new Error("actor assertion is expired or outside allowed clock skew");
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signingBytes(assertion.userId, assertion.email, assertion.issuedAt))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("actor assertion signature is invalid");
  }

  return { userId: assertion.userId, email: assertion.email, issuedAt: assertion.issuedAt };
}
