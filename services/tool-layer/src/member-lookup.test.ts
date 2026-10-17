import assert from "node:assert/strict";
import test from "node:test";

import { createRelayToolServer } from "./index.js";
import type { RelayDatabase } from "./infra/database.js";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";

async function withServer(
  lookup: (email: string, domains?: readonly string[]) => Promise<string | null>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const database = {
    async verifyRelayProject() {},
    async memberByEmail(email: string, domains?: readonly string[]) {
      return lookup(email, domains);
    },
  } as unknown as RelayDatabase;
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function lookup(port: number, token: string | null, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/internal/member-by-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("member lookup resolves a sender's email through the auth table", async () => {
  process.env.RELAY_BFF_CAPABILITY = CAPABILITY;
  const seen: Array<{ email: string; domains?: readonly string[] }> = [];
  await withServer(async (email, domains) => {
    seen.push({ email, domains });
    return "11111111-1111-4111-8111-111111111111";
  }, async (port) => {
    const result = await lookup(port, CAPABILITY, { email: "ada@houseof434.com", allowedDomains: ["houseof434.com"] });
    assert.equal(result.status, 200);
    assert.equal(result.body.userId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(seen, [{ email: "ada@houseof434.com", domains: ["houseof434.com"] }]);
  });
});

test("an unknown email resolves to null, never a guess", async () => {
  process.env.RELAY_BFF_CAPABILITY = CAPABILITY;
  await withServer(async () => null, async (port) => {
    const result = await lookup(port, CAPABILITY, { email: "stranger@example.test" });
    assert.equal(result.status, 200);
    assert.equal(result.body.userId, null);
  });
});

test("the lookup refuses a wrong or missing capability and a malformed email", async () => {
  process.env.RELAY_BFF_CAPABILITY = CAPABILITY;
  let called = 0;
  await withServer(async () => {
    called += 1;
    return null;
  }, async (port) => {
    assert.equal((await lookup(port, null, { email: "ada@houseof434.com" })).status, 401);
    assert.equal((await lookup(port, "wrong-capability", { email: "ada@houseof434.com" })).status, 401);
    assert.equal((await lookup(port, CAPABILITY, { email: "not-an-email" })).status, 400);
    assert.equal(called, 0);
  });
});
