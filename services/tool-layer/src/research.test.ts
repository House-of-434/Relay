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

const ROOT = mkdtempSync(join(tmpdir(), "research-chain-test-"));

const FAKE_SEARCH = join(ROOT, "fake-tinyfish");
writeFileSync(
  FAKE_SEARCH,
  [
    "#!/bin/sh",
    'if [ "$1" = "auth" ]; then echo \'{"authenticated":true,"source":"config"}\'; exit 0; fi',
    'case "$*" in *fixture-fail*) echo "quota exhausted" >&2; exit 1;; esac',
    'echo \'{"query":"q","results":[{"position":1,"site_name":"www.reddit.com","snippet":"fixture snippet","title":"Fixture Post","url":"https://example.com/fixture-post"}]}\'',
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const FAKE_BROWSER = join(ROOT, "fake-bladebro");
writeFileSync(
  FAKE_BROWSER,
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "bladebro v9.9.9-test"; exit 0; fi',
    'if [ "$1" = "stop" ]; then exit 0; fi',
    'echo \'{"ok":true,"is_error":false,"text":"fixture page text for testing"}\'',
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const SAVED_ENV = {
  RELAY_BLADE_BINARY: process.env.RELAY_BLADE_BINARY,
  RELAY_BLADE_ROOT: process.env.RELAY_BLADE_ROOT,
  RELAY_SEARCH_BINARY: process.env.RELAY_SEARCH_BINARY,
};

function useResearchEnv(): void {
  process.env.RELAY_BLADE_BINARY = FAKE_BROWSER;
  process.env.RELAY_BLADE_ROOT = join(ROOT, "blade");
  process.env.RELAY_SEARCH_BINARY = FAKE_SEARCH;
}

after(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

const ALICE = "423e4567-e89b-42d3-a456-426614174000";

function assertionFor(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "actor-secret-that-is-at-least-thirty-two-bytes")
    .update(JSON.stringify([userId, "person@example.test", issuedAt]))
    .digest("base64url");
  return JSON.stringify({ userId, email: "person@example.test", issuedAt, signature });
}

const database = {
  async verifyRelayProject() {},
  authenticateActorAssertion(value: string) {
    return (JSON.parse(value) as { userId: string }).userId;
  },
} as unknown as RelayDatabase;

async function session(agent: string, assertion?: string): Promise<{
  tools: string[];
  call: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  close: () => Promise<void>;
}> {
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "research-chain-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent}`), {
    requestInit: assertion ? { headers: { "x-relay-actor-user": assertion } } : {},
  });
  await client.connect(transport);
  return {
    tools: (await client.listTools()).tools.map((tool) => tool.name).sort(),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError as boolean | undefined, text: (result.content as Array<{ text?: string }>)[0]?.text ?? "" };
    },
    close: async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("scout gets the full research loop; others get no search or browser", async () => {
  useResearchEnv();
  const scout = await session("scout", assertionFor(ALICE));
  try {
    assert.deepEqual(scout.tools, [
      "browser_extract",
      "browser_open",
      "browser_read",
      "relay_read",
      "relay_write",
      "web_search",
    ]);
  } finally {
    await scout.close();
  }
  for (const agent of ["mercury", "curator"]) {
    const peer = await session(agent, assertionFor(ALICE));
    try {
      assert.ok(!peer.tools.includes("web_search"), agent);
      assert.ok(!peer.tools.some((name) => name.startsWith("browser_")), agent);
    } finally {
      await peer.close();
    }
  }
});

test("anonymous callers are rejected before seeing any tools", async () => {
  useResearchEnv();
  const server = await createRelayToolServer(database, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${(address as { port: number }).port}/mcp/scout`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    await response.text().catch(() => undefined);

    const client = new Client({ name: "research-chain-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    try {
      await assert.rejects((async () => {
        await client.connect(transport);
        await client.listTools();
      })());
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("discovery flows into browsing: web_search to browser_open to browser_read", async () => {
  useResearchEnv();
  const scout = await session("scout", assertionFor(ALICE));
  try {
    const found = await scout.call("web_search", { query: "model release" });
    assert.equal(found.isError, undefined);
    const results = JSON.parse(found.text) as Array<{ url: string; title: string; snippet: string }>;
    assert.ok(results.length > 0);
    // No provider vocabulary crosses the boundary.
    for (const result of results) {
      assert.deepEqual(Object.keys(result).sort(), ["snippet", "title", "url"]);
    }

    const discovered = results[0]!.url;
    const opened = await scout.call("browser_open", { url: discovered });
    assert.equal(opened.isError, undefined);
    assert.match(opened.text, /fixture page text/);

    const read = await scout.call("browser_read", { mode: "content" });
    assert.equal(read.isError, undefined);

    const extracted = await scout.call("browser_extract", { kind: "auto" });
    assert.equal(extracted.isError, undefined);
  } finally {
    await scout.close();
  }
});

test("provider failure is honest, never an empty success", async () => {
  useResearchEnv();
  const scout = await session("scout", assertionFor(ALICE));
  try {
    const failed = await scout.call("web_search", { query: "fixture-fail" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /quota exhausted/);
  } finally {
    await scout.close();
  }
});
