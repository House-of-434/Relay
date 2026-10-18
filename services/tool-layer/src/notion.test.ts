import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { authorizeNotion, NOTION_PERMISSIONS } from "./domain/permissions.js";
import { NO_CONNECTORS, parseConnectorState } from "./infra/connector-state.js";
import type { RelayNotionClient } from "./infra/notion.js";
import { registerNotionTools } from "./mcp/notion-server.js";

test("notion capabilities follow the agent matrix: reads shared, writes mercury-only", () => {
  assert.deepEqual([...NOTION_PERMISSIONS.scout], ["read"]);
  assert.deepEqual([...NOTION_PERMISSIONS.mercury], ["read", "write"]);
  assert.deepEqual([...NOTION_PERMISSIONS.curator], ["read"]);
  assert.doesNotThrow(() => authorizeNotion("scout", "read"));
  assert.throws(() => authorizeNotion("scout", "write"), /notion write access denied/);
  assert.doesNotThrow(() => authorizeNotion("mercury", "write"));
  assert.throws(() => authorizeNotion("curator", "write"), /notion write access denied/);
});

test("connector state carries notion alongside github and fails closed", () => {
  assert.deepEqual(NO_CONNECTORS.notion, { connected: false });
  assert.deepEqual(parseConnectorState({ github: { connected: true }, notion: { connected: true } }), {
    github: { connected: true },
    notion: { connected: true },
  });
  assert.deepEqual(parseConnectorState({}), NO_CONNECTORS);
});

const fakeClient = {
  async search() {
    return { results: [{ id: "page-1", object: "page", title: "Nakato" }] };
  },
  async getPage() {
    return { page: { id: "page-1", properties: {} } };
  },
  async queryDatabase() {
    return { rows: [], hasMore: false };
  },
  async createPage() {
    return { page: { id: "page-2" } };
  },
  async updatePage() {
    return { page: { id: "page-1" } };
  },
} as unknown as RelayNotionClient;

async function toolNames(agent: "scout" | "mercury" | "curator"): Promise<string[]> {
  const server = new McpServer({ name: "notion-test", version: "0.1.0" });
  registerNotionTools(server, agent, { client: fakeClient, actorAssertion: "assertion" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "notion-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

test("mercury sees every notion tool, including the attachment uploader", async () => {
  assert.deepEqual(await toolNames("mercury"), [
    "notion_add_comment",
    "notion_append_page_content",
    "notion_archive_page",
    "notion_attach_attachment",
    "notion_create_page",
    "notion_get_comments",
    "notion_get_database",
    "notion_get_page",
    "notion_get_page_content",
    "notion_list_users",
    "notion_query_db",
    "notion_search",
    "notion_update_page",
  ]);
});

test("scout and curator see only notion reads, including content, users, and comments", async () => {
  const reads = [
    "notion_get_comments",
    "notion_get_database",
    "notion_get_page",
    "notion_get_page_content",
    "notion_list_users",
    "notion_query_db",
    "notion_search",
  ];
  assert.deepEqual(await toolNames("scout"), reads);
  assert.deepEqual(await toolNames("curator"), reads);
});

test("a scout write attempt fails closed at the tool", async () => {
  const server = new McpServer({ name: "notion-test", version: "0.1.0" });
  registerNotionTools(server, "scout", { client: fakeClient, actorAssertion: "assertion" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "notion-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: "notion_create_page",
      arguments: { databaseId: "3e55160bf13180d7a0c9d8809fa760ad", properties: {} },
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
