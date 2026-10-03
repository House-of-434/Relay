import { createHmac, timingSafeEqual } from "node:crypto";

/** Must stay identical to the harness/tool-layer signing scheme. */
export const ACTOR_ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface RelayActor {
  userId: string;
  email: string;
}

export class ActorAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorAssertionError";
  }
}

function signingBytes(userId: string, email: string, issuedAt: number): string {
  return JSON.stringify([userId, email, issuedAt]);
}

function secretKey(secret: string): string {
  if (Buffer.byteLength(secret) < 32) {
    throw new ActorAssertionError("actor assertion secret is not configured");
  }
  return secret;
}

/**
 * The BFF verifies the harness's signed actor assertion itself rather than
 * trusting that a request arrived from the Tool Layer. The signed user id is
 * the only identity used to look up Google credentials.
 */
export function verifyActorAssertion(
  value: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): RelayActor {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new ActorAssertionError("actor assertion secret is not configured");
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new ActorAssertionError("actor assertion is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActorAssertionError("actor assertion is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActorAssertionError("actor assertion is invalid");
  }

  const assertion = parsed as Record<string, unknown>;
  if (Object.keys(assertion).sort().join(",") !== "email,issuedAt,signature,userId" ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.email !== "string" || assertion.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assertion.email) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new ActorAssertionError("actor assertion is invalid");
  }

  if (Math.abs(Math.floor(now / 1000) - assertion.issuedAt) > ACTOR_ASSERTION_MAX_SKEW_SECONDS) {
    throw new ActorAssertionError("actor assertion is expired or outside allowed clock skew");
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signingBytes(assertion.userId, assertion.email, assertion.issuedAt))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ActorAssertionError("actor assertion signature is invalid");
  }

  return { userId: assertion.userId, email: assertion.email };
}