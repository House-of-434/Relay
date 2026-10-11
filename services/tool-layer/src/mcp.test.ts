import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createRelayToolServer } from "./index.js";
import { signActorAssertion } from "./infra/actor-assertion.js";
import type { RelayDatabase } from "./infra/database.js";

const SECRET = "actor-secret-that-is-at-least-thirty-two-bytes";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("HTTP MCP exposes agent-scoped tools and keeps agent permissions server-bound", async () => {
  const userId = "1457cb2a-7543-4b48-8854-a63cd160241f";
  const assertion = signActorAssertion({ userId, botId: BOT_ID, threadId: THREAD_ID }, SECRET);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let failRead = false;
  const database = {
    async verifyRelayProject() {},
    authenticateActorAssertion(value: string) {
      assert.equal(value, assertion);
      const actor = JSON.parse(value) as { userId: string; botId: string; threadId: string; issuedAt: number };
      return actor;
    },
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
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/scout`), {
    requestInit: { headers: { "x-relay-actor-user": assertion } },
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["browser_extract", "browser_open", "browser_read", "get_meeting_transcript", "relay_read", "relay_write", "search_meetings", "web_search"]);

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
    const mercuryTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/mercury`), {
      requestInit: { headers: { "x-relay-actor-user": assertion } },
    });
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

test("transcript tables are readable but never writable through agent tools", async () => {
  const userId = "1457cb2a-7543-4b48-8854-a63cd160241f";
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "actor-secret-that-is-at-least-thirty-two-bytes")
    .update(JSON.stringify([userId, "person@example.test", issuedAt])).digest("base64url");
  const assertion = JSON.stringify({ userId, email: "person@example.test", issuedAt, signature });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const database = {
    async verifyRelayProject() {},
    async authenticateActorAssertion(value: string) {
      assert.equal(value, assertion);
      return userId;
    },
    async read(...args: unknown[]) {
      calls.push({ method: "read", args });
      return [{ id: "meeting-1", title: "Weekly sync", status: "completed" }];
    },
    async write(...args: unknown[]) {
      calls.push({ method: "write", args });
      return { id: "meeting-1" };
    },
    async getMeetingTranscript(...args: unknown[]) {
      calls.push({ method: "getMeetingTranscript", args });
      return { meeting: { id: "meeting-1" }, segments: [], total_length: 0, complete: true };
    },
    async searchMeetings(...args: unknown[]) {
      calls.push({ method: "search", args });
      return [];
    },
  } as unknown as RelayDatabase;

  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "relay-transcripts-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/curator`), {
    requestInit: { headers: { "x-relay-actor-user": assertion } },
  });

  try {
    await client.connect(transport);

    const listed = await client.callTool({
      name: "relay_read",
      arguments: { table: "transcripts.meetings", filters: { status: "completed" }, limit: 10 },
    });
    assert.equal(listed.isError, undefined);
    assert.equal(calls.some((call) => call.method === "read"), true);

    for (const table of ["transcripts.meetings", "transcripts.meeting_segments"]) {
      const denied = await client.callTool({
        name: "relay_write",
        arguments: { table, operation: "insert", data: { title: "forged" } },
      });
      assert.equal(denied.isError, true, table);
    }
    assert.equal(calls.some((call) => call.method === "write"), false);

    const transcript = await client.callTool({
      name: "get_meeting_transcript",
      arguments: { meeting_id: "meeting-1" },
    });
    assert.equal(transcript.isError, undefined);
    assert.equal(calls.some((call) => call.method === "getMeetingTranscript"), true);

    const search = await client.callTool({
      name: "search_meetings",
      arguments: { query: "revenue" },
    });
    assert.equal(search.isError, undefined);
    assert.equal(calls.some((call) => call.method === "search"), true);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("only an agent with the capability is offered Gmail or calendar tools", async () => {
  const userId = "1457cb2a-7543-4b48-8854-a63cd160241f";
  const assertion = signActorAssertion({ userId, botId: BOT_ID, threadId: THREAD_ID }, SECRET);
  const database = {
    async verifyRelayProject() {},
    authenticateActorAssertion(value: string) {
      assert.equal(value, assertion);
      return JSON.parse(value);
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
    "get_meeting_transcript",
    "relay_read",
    "relay_write",
    "search_meetings",
    "web_search",
  ]);
  assert.deepEqual(await names("curator"), ["get_meeting_transcript", "relay_read", "relay_write", "search_meetings"], "curator");
});

test("unauthenticated MCP callers cannot reach relay data", async () => {
  const database = {
    async verifyRelayProject() {},
    async read() {
      throw new Error("must not reach database without an actor");
    },
    async write() {
      throw new Error("must not reach database without an actor");
    },
  } as unknown as RelayDatabase;

  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const agent of ["scout", "mercury", "curator"]) {
      const endpoint: string = `http://127.0.0.1:${(address as { port: number }).port}/mcp/${agent}`;
      const noAuth: Response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(noAuth.status, 401, agent);
      await noAuth.text().catch(() => undefined);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
