import assert from "node:assert/strict";
import test from "node:test";

import { signActorAssertion } from "./infra/actor-assertion.js";
import { RelayDatabase } from "./infra/database.js";
import { createRelayToolServer } from "./index.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";

test("MCP rejects actor headers that are spoofed, unsigned, expired, or signed with another secret", async () => {
  const database = new RelayDatabase({
    RELAY_DB_URL: "https://relay-test.supabase.co",
    RELAY_DB_PROJECT_REF: "relay-test",
    RELAY_DB_SERVICE_ROLE_KEY: "test-service-role-key",
    RELAY_ALLOWED_EMAIL_DOMAINS: "houseof434.com",
    RELAY_TOOL_ACTOR_SECRET: SECRET,
  });
  database.verifyRelayProject = async () => {};
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp/scout`;

  const signed = signActorAssertion(
    { userId: USER_ID, email: "analyst@houseof434.com" }, SECRET,
  );
  const old = signActorAssertion(
    { userId: USER_ID, email: "analyst@houseof434.com" }, SECRET,
    Math.floor(Date.now() / 1000) - 301,
  );
  const invalidSignature = signActorAssertion(
    { userId: USER_ID, email: "analyst@houseof434.com" },
    "different-relay-tool-actor-secret-over-32-bytes",
  );
  const missingSignature = JSON.stringify({ userId: USER_ID, email: "analyst@houseof434.com", issuedAt: Math.floor(Date.now() / 1000) });
  const attempts = [
    "analyst@houseof434.com",
    missingSignature,
    old,
    invalidSignature,
    signed.replace(USER_ID, "00000000-0000-4000-8000-000000000000"),
  ];

  try {
    for (const assertion of attempts) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "x-relay-actor-user": assertion },
      });
      assert.equal(response.status, 401, assertion);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
