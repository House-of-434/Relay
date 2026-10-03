import assert from "node:assert/strict";
import test from "node:test";

import { signActorAssertion } from "./infra/actor-assertion.js";
import { RelayDatabase } from "./infra/database.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";

function database(overrides: Record<string, string | undefined> = {}): RelayDatabase {
  return new RelayDatabase({
    RELAY_DB_URL: "https://relay-test.supabase.co",
    RELAY_DB_PROJECT_REF: "relay-test",
    RELAY_DB_SERVICE_ROLE_KEY: "test-service-role-key",
    RELAY_ALLOWED_EMAIL_DOMAINS: "houseof434.com",
    RELAY_TOOL_ACTOR_SECRET: SECRET,
    ...overrides,
  });
}

test("direct bearer authentication returns verified Supabase user id and still gates the verified email domain", async () => {
  const db = database();
  const auth = db.client("relay").auth as unknown as {
    getUser(token: string): Promise<{ data: { user: { id: string; email: string } }; error: null }>;
  };
  auth.getUser = async (token) => {
    assert.equal(token, "verified-access-token");
    return { data: { user: { id: USER_ID, email: "Analyst@HouseOf434.com" } }, error: null };
  };

  assert.equal(await db.authenticateUser("verified-access-token"), USER_ID);

  auth.getUser = async () => ({
    data: { user: { id: USER_ID, email: "analyst@outside.example" } },
    error: null,
  });
  await assert.rejects(db.authenticateUser("verified-access-token"), /email domain is not allowed/);

  auth.getUser = async () => ({ data: { user: { id: "not-a-uuid", email: "analyst@houseof434.com" } }, error: null });
  await assert.rejects(db.authenticateUser("verified-access-token"), /UUID/);
});

test("signed harness actor assertions resolve to user id and validate email only as metadata", () => {
  const db = database();
  const assertion = signActorAssertion({ userId: USER_ID, email: "analyst@houseof434.com" }, SECRET);
  assert.equal(db.authenticateActorAssertion(assertion), USER_ID);

  const outsideDomain = signActorAssertion({ userId: USER_ID, email: "analyst@outside.example" }, SECRET);
  assert.throws(() => db.authenticateActorAssertion(outsideDomain), /email domain is not allowed/);
});
