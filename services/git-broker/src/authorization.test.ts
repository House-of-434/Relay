import assert from "node:assert/strict";
import test from "node:test";

import { signPublishAuthorization, verifyPublishAuthorization } from "./authorization.ts";

const SECRET = "publish-secret-at-least-thirty-two-bytes-long";
const USER = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD = "9c858901-8a57-4791-81fe-4c455b099bc9";

function authorization(overrides: Partial<Parameters<typeof signPublishAuthorization>[0]> = {}) {
  return signPublishAuthorization({
    userId: USER,
    botId: BOT,
    threadId: THREAD,
    agent: "scout",
    repo: "octo/repo",
    path: "repos/octo__repo",
    branch: "relay/fix-login",
    commit: "a".repeat(40),
    title: "Fix login",
    body: "Checks pass.",
    attachments: ["before.png"],
    nonce: "nonce-1234567890",
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }, SECRET);
}

test("round-trips an approved publish payload", () => {
  const signed = authorization();
  assert.deepEqual(verifyPublishAuthorization(signed, SECRET), signed);
});

test("rejects tampering, expiry, and non-relay branches", () => {
  const signed = authorization();
  assert.throws(() => verifyPublishAuthorization({ ...signed, commit: "b".repeat(40) }, SECRET), /signature/);
  assert.throws(() => verifyPublishAuthorization(authorization({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), SECRET), /expired/);
  assert.throws(() => verifyPublishAuthorization({ ...signed, branch: "main" }, SECRET), /invalid/);
});
