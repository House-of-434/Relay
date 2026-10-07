import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createRelayToolServer } from "./index.js";
import type { RelayDatabase } from "./infra/database.js";

test("HTTP MCP exposes exactly two tools and keeps agent permissions server-bound", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let failRead = false;
  const database = {
    async verifyRelayProject() {},
    async read(...args: unknown[]) {
      calls.push({ method: "read", args });
      if (failRead) throw new Error("database unavailable");
      return [{ id: "company-1", name: "Acme", status: "active" }];
    },
    async write(...args: unknown[]) {
      calls.push({ method: "write", args });
      return { id: "company-1" };
    },
  } as unknown as RelayDatabase;

  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "relay-tools-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/scout`));

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["relay_read", "relay_write"]);

    const read = await client.callTool({ name: "relay_read", arguments: { table: "app.companies", limit: 3 } });
    assert.equal(read.isError, undefined);
    assert.equal(calls[0]?.method, "read");
    assert.equal(calls[0]?.args[0], "relay");

    failRead = true;
    const readFailure = await client.callTool({ name: "relay_read", arguments: { table: "app.companies" } });
    assert.equal(readFailure.isError, true);
    failRead = false;

    const denied = await client.callTool({
      name: "relay_write",
      arguments: {
        table: "history.generated_docs",
        operation: "insert",
        data: { kind: "brief", body: "forged" },
        agent: "curator",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(calls.some((call) => call.method === "write"), false);

    const mercuryClient = new Client({ name: "relay-mercury-test", version: "0.1.0" });
    const mercuryTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/mercury`));
    try {
      await mercuryClient.connect(mercuryTransport);
      const safetyRead = await mercuryClient.callTool({
        name: "relay_read",
        arguments: { table: "public.suppressed_emails", filters: { email: "recipient@example.com" } },
      });
      assert.equal(safetyRead.isError, true);
      assert.equal(calls.filter((call) => call.method === "read").length, 2);
    } finally {
      await mercuryClient.close();
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("only an agent with the capability is offered Gmail or calendar tools", async () => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const userId = "1457cb2a-7543-4b48-8854-a63cd160241f";
  const signature = createHmac("sha256", "actor-secret-that-is-at-least-thirty-two-bytes")
    .update(JSON.stringify([userId, "person@example.test", issuedAt])).digest("base64url");
  const assertion = JSON.stringify({ userId, email: "person@example.test", issuedAt, signature });
  const database = {
    async verifyRelayProject() {},
    async authenticateActorAssertion(value: string) {
      assert.equal(value, assertion);
      return userId;
    },
  } as unknown as RelayDatabase;

  const names = async (agent: string) => {
    const server = await createRelayToolServer(database, 0);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new Client({ name: "visibility-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent}`), {
      requestInit: { headers: { "x-relay-actor-user": assertion } },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  const mercury = await names("mercury");
  assert.equal(mercury.includes("gmail_search"), true);
  assert.equal(mercury.includes("calendar_delete_event"), true);

  // Scout and Curator hold no Gmail or calendar capability, so those tools must
  // not be advertised at all rather than offered and refused.
  // Scout additionally holds the research capabilities, visible only to an
  // authenticated caller; Curator holds none.
  assert.deepEqual(await names("scout"), [
    "browser_extract",
    "browser_open",
    "browser_read",
    "relay_read",
    "relay_write",
    "web_search",
  ]);
  assert.deepEqual(await names("curator"), ["relay_read", "relay_write"], "curator");
});
