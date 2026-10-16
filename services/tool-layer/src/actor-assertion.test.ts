import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_ASSERTION_MAX_SKEW_SECONDS,
  ACTOR_ASSERTION_PURPOSE,
  signActorAssertion,
  verifyActorAssertion,
} from "./infra/actor-assertion.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const ACTOR = { userId: USER_ID, botId: BOT_ID, threadId: THREAD_ID, agent: "scout" };
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";
const NOW = 1_700_000_000_000;

test("actor assertion signs and verifies user, bot, thread, and issued-at", () => {
  const payload = signActorAssertion(ACTOR, SECRET, NOW / 1000);
  assert.deepEqual(verifyActorAssertion(payload, SECRET, NOW), {
    userId: USER_ID,
    botId: BOT_ID,
    threadId: THREAD_ID,
    agent: "scout",
    issuedAt: NOW / 1000,
  });
});

test("the HMAC covers a fixed purpose string", () => {
  assert.equal(ACTOR_ASSERTION_PURPOSE, "relay-actor");
});

test("spoofed, unsigned, malformed, expired, and invalid-signature assertions are rejected", () => {
  const valid = JSON.parse(signActorAssertion(ACTOR, SECRET, NOW / 1000)) as Record<string, unknown>;

  assert.throws(() => verifyActorAssertion("relay-actor", SECRET, NOW), /invalid/);
  const unsigned = { ...valid };
  delete unsigned.signature;
  assert.throws(() => verifyActorAssertion(JSON.stringify(unsigned), SECRET, NOW), /invalid/);

  const spoofed = { ...valid, userId: "00000000-0000-4000-8000-000000000000" };
  assert.throws(() => verifyActorAssertion(JSON.stringify(spoofed), SECRET, NOW), /signature is invalid/);

  const expired = signActorAssertion(ACTOR, SECRET, NOW / 1000 - ACTOR_ASSERTION_MAX_SKEW_SECONDS - 1);
  assert.throws(() => verifyActorAssertion(expired, SECRET, NOW), /expired/);

  const badSignature = { ...valid, signature: "A".repeat(43) };
  assert.throws(() => verifyActorAssertion(JSON.stringify(badSignature), SECRET, NOW), /signature is invalid/);

  const malformedThread = signActorAssertion(ACTOR, SECRET, NOW / 1000).replace(THREAD_ID, "not-a-uuid");
  assert.throws(() => verifyActorAssertion(malformedThread, SECRET, NOW), /invalid/);
});

test("an email-bearing or otherwise reshaped payload is rejected, not silently accepted", () => {
  const emailBearing = JSON.stringify({
    userId: USER_ID,
    email: "analyst@houseof434.com",
    botId: BOT_ID,
    threadId: THREAD_ID,
    issuedAt: NOW / 1000,
    signature: "A".repeat(43),
  });
  assert.throws(() => verifyActorAssertion(emailBearing, SECRET, NOW), /invalid/);

  const threeField = JSON.stringify({
    userId: USER_ID,
    issuedAt: NOW / 1000,
    signature: "A".repeat(43),
  });
  assert.throws(() => verifyActorAssertion(threeField, SECRET, NOW), /invalid/);
});

test("signing and verification require the distinct service actor secret", () => {
  assert.throws(() => signActorAssertion(ACTOR, undefined, NOW / 1000), /RELAY_TOOL_ACTOR_SECRET/);
  const signed = signActorAssertion(ACTOR, SECRET, NOW / 1000);
  assert.throws(() => verifyActorAssertion(signed, "too-short", NOW), /RELAY_TOOL_ACTOR_SECRET/);
});
