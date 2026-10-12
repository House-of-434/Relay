import assert from "node:assert/strict";
import { test } from "node:test";

import type { RelayDatabase } from "./infra/database.js";
import { databaseToolCallLogger, hashToolArgs, instrumentToolCalls, type ToolCallOutcome } from "./mcp/tool-log.js";

function fakeServer() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    registerTool(name: string, _config: unknown, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
  };
}

test("records a successful call with the argument hash and no error", async () => {
  const server = fakeServer();
  const logged: ToolCallOutcome[] = [];
  instrumentToolCalls(server, (outcome) => { logged.push(outcome); });
  server.registerTool("browser_open", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));

  await server.handlers.get("browser_open")!({ url: "https://example.test" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.tool, "browser_open");
  assert.equal(logged[0]!.argsHash, hashToolArgs({ url: "https://example.test" }));
  assert.equal(logged[0]!.error, null);
  assert.equal(typeof logged[0]!.ms, "number");
});

test("records the refusal text of an isError result", async () => {
  const server = fakeServer();
  const logged: ToolCallOutcome[] = [];
  instrumentToolCalls(server, (outcome) => { logged.push(outcome); });
  server.registerTool("gmail_read", {}, async () => ({ isError: true, content: [{ type: "text", text: "Gmail is not connected" }] }));

  await server.handlers.get("gmail_read")!({ messageId: "x" });
  assert.equal(logged[0]!.error, "Gmail is not connected");
});

test("records a thrown error and rethrows it", async () => {
  const server = fakeServer();
  const logged: ToolCallOutcome[] = [];
  instrumentToolCalls(server, (outcome) => { logged.push(outcome); });
  server.registerTool("browser_read", {}, async () => { throw new Error("boom"); });

  await assert.rejects(() => Promise.resolve(server.handlers.get("browser_read")!({})) as Promise<unknown>, /boom/);
  assert.equal(logged[0]!.error, "boom");
});

test("a failing sink never fails the tool call", async () => {
  const server = fakeServer();
  instrumentToolCalls(server, () => { throw new Error("sink down"); });
  server.registerTool("web_search", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));

  const result = await server.handlers.get("web_search")!({ query: "x" });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
});

test("the database sink attributes the actor and agent and truncates errors", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const database = { logToolCall: async (input: Record<string, unknown>) => { calls.push(input); } } as unknown as RelayDatabase;
  const log = databaseToolCallLogger(database, "scout", "b2b16139-72d4-4f2a-9a81-a8c6c0605116");

  await log({ tool: "relay_read", argsHash: "abc", ms: 12, error: "x".repeat(5000) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.userId, "b2b16139-72d4-4f2a-9a81-a8c6c0605116");
  assert.equal(calls[0]!.agent, "scout");
  assert.equal(calls[0]!.tool, "relay_read");
  assert.equal((calls[0]!.error as string).length, 1000);
});
