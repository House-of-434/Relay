import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_ASSERTION_MAX_SKEW_SECONDS,
  signActorAssertion,
  verifyActorAssertion,
} from "./infra/actor-assertion.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";
const NOW = 1_700_000_000_000;

test("actor assertion signs and verifies a UUID, email metadata, and issued-at", () => {
  const payload = signActorAssertion({ userId: USER_ID, email: "Analyst@HouseOf434.com" }, SECRET, NOW / 1000);
  assert.deepEqual(verifyActorAssertion(payload, SECRET, NOW), {
    userId: USER_ID,
    email: "analyst@houseof434.com",
    issuedAt: NOW / 1000,
  });
});

test("spoofed, unsigned, malformed, expired, and invalid-signature assertions are rejected", () => {
  const valid = JSON.parse(signActorAssertion(
    { userId: USER_ID, email: "analyst@houseof434.com" }, SECRET, NOW / 1000,
  )) as Record<string, unknown>;

  assert.throws(() => verifyActorAssertion("analyst@houseof434.com", SECRET, NOW), /invalid/);
  const unsigned = { ...valid };
  delete unsigned.signature;
  assert.throws(() => verifyActorAssertion(JSON.stringify(unsigned), SECRET, NOW), /invalid/);

  const spoofed = { ...valid, userId: "00000000-0000-4000-8000-000000000000" };
  assert.throws(() => verifyActorAssertion(JSON.stringify(spoofed), SECRET, NOW), /signature is invalid/);

  const expired = signActorAssertion(
    { userId: USER_ID, email: "analyst@houseof434.com" },
    SECRET,
    NOW / 1000 - ACTOR_ASSERTION_MAX_SKEW_SECONDS - 1,
  );
  assert.throws(() => verifyActorAssertion(expired, SECRET, NOW), /expired/);

  const badSignature = { ...valid, signature: "A".repeat(43) };
  assert.throws(() => verifyActorAssertion(JSON.stringify(badSignature), SECRET, NOW), /signature is invalid/);

  const malformedUserId = signActorAssertion(
    { userId: "1457cb2a-7543-4b48-8854-a63cd160241f", email: "analyst@houseof434.com" }, SECRET, NOW / 1000,
  ).replace(USER_ID, "not-a-uuid");
  assert.throws(() => verifyActorAssertion(malformedUserId, SECRET, NOW), /invalid/);
});

test("signing and verification require the distinct service actor secret", () => {
  assert.throws(() => signActorAssertion({ userId: USER_ID, email: "analyst@houseof434.com" }, undefined, NOW / 1000), /RELAY_TOOL_ACTOR_SECRET/);
  const signed = signActorAssertion({ userId: USER_ID, email: "analyst@houseof434.com" }, SECRET, NOW / 1000);
  assert.throws(() => verifyActorAssertion(signed, "too-short", NOW), /RELAY_TOOL_ACTOR_SECRET/);
});
