import assert from "node:assert/strict";
import test from "node:test";

import { signActorAssertion } from "./infra/actor-assertion.js";
import { RelayDatabase } from "./infra/database.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";

function database(overrides: Record<string, string | undefined> = {}): RelayDatabase {
  return new RelayDatabase({
    RELAY_DB_URL: "https://relay-test.supabase.co",
    RELAY_DB_PROJECT_REF: "relay-test",
    RELAY_DB_SERVICE_ROLE_KEY: "test-service-role-key",
    RELAY_TOOL_ACTOR_SECRET: SECRET,
    ...overrides,
  });
}

test("a signed harness actor assertion resolves to the owner, bot, and thread", () => {
  const db = database();
  const assertion = signActorAssertion({ userId: USER_ID, botId: BOT_ID, threadId: THREAD_ID }, SECRET);
  const actor = db.authenticateActorAssertion(assertion);
  assert.equal(actor.userId, USER_ID);
  assert.equal(actor.botId, BOT_ID);
  assert.equal(actor.threadId, THREAD_ID);
  assert.equal(typeof actor.issuedAt, "number");
});

test("an assertion signed with another secret is refused", () => {
  const db = database();
  const assertion = signActorAssertion(
    { userId: USER_ID, botId: BOT_ID, threadId: THREAD_ID },
    "different-relay-tool-actor-secret-over-32-bytes",
  );
  assert.throws(() => db.authenticateActorAssertion(assertion), /signature is invalid/);
});
