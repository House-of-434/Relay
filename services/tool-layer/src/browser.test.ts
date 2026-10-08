import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createRelayToolServer } from "./index.js";
import type { RelayDatabase } from "./infra/database.js";

const ROOT = mkdtempSync(join(tmpdir(), "blade-http-test-"));
const FAKE_BINARY = join(ROOT, "fake-bladebro");
writeFileSync(
  FAKE_BINARY,
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "bladebro v9.9.9-test"; exit 0; fi',
    'if [ "$1" = "stop" ]; then exit 0; fi',
    'case "$*" in *fixture-fail*) echo \'{"ok":false,"is_error":true,"text":"blocked: fixture"}\'; exit 1;; esac',
    'echo "{\\"ok\\":true,\\"is_error\\":false,\\"text\\":\\"fixture page text for testing home=$BLADE_HOME\\"}"',
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const SAVED_ENV = {
  RELAY_BLADE_BINARY: process.env.RELAY_BLADE_BINARY,
  RELAY_BLADE_ROOT: process.env.RELAY_BLADE_ROOT,
};

function useBladeEnv(extra: Record<string, string> = {}): void {
  process.env.RELAY_BLADE_BINARY = FAKE_BINARY;
  process.env.RELAY_BLADE_ROOT = join(ROOT, "blade");
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

after(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

const ALICE = "223e4567-e89b-42d3-a456-426614174000";
const BOB = "223e4567-e89b-42d3-a456-426614174001";

function assertionFor(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "actor-secret-that-is-at-least-thirty-two-bytes")
    .update(JSON.stringify([userId, "person@example.test", issuedAt]))
    .digest("base64url");
  return JSON.stringify({ userId, email: "person@example.test", issuedAt, signature });
}

const database = {
  async verifyRelayProject() {},
  // NOTE: the real method is synchronous; an async mock would hand every
  // request a Promise userId, which strict workspace validation rejects.
  authenticateActorAssertion(value: string) {
    return (JSON.parse(value) as { userId: string }).userId;
  },
} as unknown as RelayDatabase;

async function toolNames(agent: string, assertion?: string): Promise<string[]> {
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "browser-visibility-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent}`), {
    requestInit: assertion ? { headers: { "x-relay-actor-user": assertion } } : {},
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function callTool(
  agent: string,
  assertion: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "browser-call-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent}`), {
    requestInit: assertion ? { headers: { "x-relay-actor-user": assertion } } : {},
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: result.isError as boolean | undefined, text };
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("authenticated scout sees browser tools; others do not", async () => {
  useBladeEnv();
  assert.deepEqual(await toolNames("scout", assertionFor(ALICE)), [
    "browser_extract",
    "browser_open",
    "browser_read",
    "relay_read",
    "relay_write",
    "web_search",
  ]);
  for (const agent of ["mercury", "curator"]) {
    const listed = await toolNames(agent, assertionFor(ALICE));
    assert.ok(!listed.some((name) => name.startsWith("browser_")), agent);
    assert.ok(!listed.includes("web_search"), agent);
  }
  assert.deepEqual(await toolNames("scout"), ["relay_read", "relay_write"]);
});

test("browser tools drive the daemon and stay user-scoped end to end", async () => {
  useBladeEnv();
  const opened = await callTool("scout", assertionFor(ALICE), "browser_open", { url: "https://example.com" });
  assert.equal(opened.isError, undefined);
  assert.match(opened.text, /fixture page text/);

  const read = await callTool("scout", assertionFor(ALICE), "browser_read", { mode: "content" });
  assert.equal(read.isError, undefined);

  const extracted = await callTool("scout", assertionFor(BOB), "browser_extract", {
    url: "https://example.com",
    kind: "auto",
  });
  assert.equal(extracted.isError, undefined);

  // The daemon each request reached ran under a different BLADE_HOME: the
  // workspace followed the actor, not the tool arguments.
  assert.match(opened.text, new RegExp(`home=.*${ALICE}`));
  assert.match(extracted.text, new RegExp(`home=.*${BOB}`));
  assert.ok(!extracted.text.includes(ALICE));
});

test("invalid URLs and page failures refuse clearly", async () => {
  useBladeEnv();
  const bad = await callTool("scout", assertionFor(ALICE), "browser_open", { url: "ftp://example.com/x" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /http\(s\)/);
});

test("page-level failure surfaces the verdict instead of fabricating", async () => {
  useBladeEnv();
  const blocked = await callTool("scout", assertionFor(ALICE), "browser_open", {
    url: "https://example.com/fixture-fail",
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /blocked: fixture/);
});
