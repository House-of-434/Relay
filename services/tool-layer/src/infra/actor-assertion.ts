import { createHmac, timingSafeEqual } from "node:crypto";

export const ACTOR_ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

/** Fixed HMAC input prefix: a signature made for this purpose cannot be
 * replayed as a signature for another. Must match the harness and BFF. */
export const ACTOR_ASSERTION_PURPOSE = "relay-actor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = "agent,botId,issuedAt,signature,threadId,userId";
const KEYS_WITH_MAIL = "agent,botId,issuedAt,mailRouted,signature,threadId,userId";

export const RELAY_AGENT_ROLES = ["scout", "mercury", "curator"] as const;
export type RelayAgentRole = (typeof RELAY_AGENT_ROLES)[number];

export type RelayActorAssertion = {
  userId: string;
  botId: string;
  threadId: string;
  agent: RelayAgentRole;
  mailRouted?: true;
  issuedAt: number;
  signature: string;
};

export type RelayActorContext = Omit<RelayActorAssertion, "signature">;

function signingBytes(
  userId: string,
  issuedAt: number,
  botId: string,
  threadId: string,
  agent: string,
  mailRouted?: true,
): string {
  return JSON.stringify([
    ACTOR_ASSERTION_PURPOSE, userId, issuedAt, botId, threadId, agent,
    ...(mailRouted ? [true] : []),
  ]);
}

function secretKey(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function isAgentRole(value: unknown): value is RelayAgentRole {
  return typeof value === "string" && (RELAY_AGENT_ROLES as readonly string[]).includes(value);
}

export function signActorAssertion(
  actor: { userId: string; botId: string; threadId: string; agent: string },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
  options?: { mailRouted?: true },
): string {
  const userId = actor.userId.trim().toLowerCase();
  const botId = actor.botId.trim().toLowerCase();
  const threadId = actor.threadId.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay actor user id must be a UUID");
  if (!UUID.test(botId)) throw new Error("Relay actor bot id must be a UUID");
  if (!UUID.test(threadId)) throw new Error("Relay actor thread id must be a UUID");
  if (!isAgentRole(actor.agent)) throw new Error("Relay actor agent must be a known role");
  if (!Number.isSafeInteger(issuedAt)) throw new Error("Relay actor assertion timestamp is invalid");

  const mailRouted = options?.mailRouted === true;
  const signature = createHmac("sha256", secretKey(secret))
    .update(signingBytes(userId, issuedAt, botId, threadId, actor.agent, mailRouted ? true : undefined))
    .digest("base64url");
  return JSON.stringify({
    userId, issuedAt, botId, threadId, agent: actor.agent,
    ...(mailRouted ? { mailRouted: true } : {}),
    signature,
  });
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
  const mailRouted = keys === KEYS_WITH_MAIL;
  if ((keys !== KEYS && !mailRouted) ||
      (mailRouted && assertion.mailRouted !== true) ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.botId !== "string" || !UUID.test(assertion.botId) ||
      typeof assertion.threadId !== "string" || !UUID.test(assertion.threadId) ||
      !isAgentRole(assertion.agent) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new Error("actor assertion is invalid");
  }

  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - assertion.issuedAt) > ACTOR_ASSERTION_MAX_SKEW_SECONDS) {
    throw new Error("actor assertion is expired or outside allowed clock skew");
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signingBytes(
      assertion.userId,
      assertion.issuedAt,
      assertion.botId,
      assertion.threadId,
      assertion.agent,
      mailRouted ? true : undefined,
    ))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("actor assertion signature is invalid");
  }

  return {
    userId: assertion.userId,
    botId: assertion.botId,
    threadId: assertion.threadId,
    agent: assertion.agent,
    ...(mailRouted ? { mailRouted: true as const } : {}),
    issuedAt: assertion.issuedAt,
  };
}
