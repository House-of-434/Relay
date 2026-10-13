import { createHmac, timingSafeEqual } from "node:crypto";

/** Must stay identical to the harness/tool-layer signing scheme. */
export const ACTOR_ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

/** Fixed HMAC input prefix: a signature made for this purpose cannot be
 * replayed as a signature for another. Must match the harness and Tool Layer. */
export const ACTOR_ASSERTION_PURPOSE = "relay-actor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = "botId,issuedAt,signature,threadId,userId";

export interface RelayActor {
  userId: string;
  botId: string;
  threadId: string;
}

export class ActorAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorAssertionError";
  }
}

function signingBytes(userId: string, issuedAt: number, botId: string, threadId: string): string {
  return JSON.stringify([ACTOR_ASSERTION_PURPOSE, userId, issuedAt, botId, threadId]);
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
  const keys = Object.keys(assertion).sort().join(",");
  if (keys !== KEYS ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.botId !== "string" || !UUID.test(assertion.botId) ||
      typeof assertion.threadId !== "string" || !UUID.test(assertion.threadId) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new ActorAssertionError("actor assertion is invalid");
  }

  if (Math.abs(Math.floor(now / 1000) - assertion.issuedAt) > ACTOR_ASSERTION_MAX_SKEW_SECONDS) {
    throw new ActorAssertionError("actor assertion is expired or outside allowed clock skew");
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signingBytes(assertion.userId, assertion.issuedAt, assertion.botId, assertion.threadId))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ActorAssertionError("actor assertion signature is invalid");
  }

  return { userId: assertion.userId, botId: assertion.botId, threadId: assertion.threadId };
}
