import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { NotionConnectionStore } from "./notion-connections.ts";
import {
  handleInternalNotion,
  INTERNAL_NOTION_APPEND_CONTENT,
  INTERNAL_NOTION_ARCHIVE,
  INTERNAL_NOTION_ATTACH,
  INTERNAL_NOTION_COMMENT_ADD,
  INTERNAL_NOTION_COMMENTS,
  INTERNAL_NOTION_CREATE,
  INTERNAL_NOTION_DATABASE_GET,
  INTERNAL_NOTION_GET,
  INTERNAL_NOTION_PAGE_CONTENT,
  INTERNAL_NOTION_QUERY,
  INTERNAL_NOTION_SEARCH,
  INTERNAL_NOTION_UPDATE,
  INTERNAL_NOTION_USERS,
} from "./notion-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const TOKEN_KEY = Buffer.alloc(32, 0x4e).toString("base64");
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const WORKSPACE_ID = "workspace-fixture-0001";
const ALLOWED_DB = "3e55160bf13180d7a0c9d8809fa760ad";
const OTHER_DB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALLOWED_PAGE = "3fb5160bf13180ffb7b9c1d97439bd2b";
const OTHER_PAGE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function actorAssertion(userId: string, agent: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", userId, issuedAt, BOT_ID, THREAD_ID, agent]))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId: BOT_ID, threadId: THREAD_ID, agent, signature });
}

function notionPage(id: string, databaseId: string) {
  return {
    object: "page",
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: databaseId },
    properties: {
      Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Nakato" } }] },
    },
  };
}

/** Stub Notion REST API keyed by request path. */
function notionFetcher(seen: string[]) {
  return async (url: URL, init?: RequestInit): Promise<Response> => {
    const path = url.pathname;
    const method = init?.method ?? "GET";
    seen.push(`${method} ${path}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && path === "/v1/search") {
      return json(200, {
        results: [
          { object: "page", id: ALLOWED_PAGE, url: `https://notion.so/${ALLOWED_PAGE}`, properties: notionPage(ALLOWED_PAGE, ALLOWED_DB).properties },
          { object: "database", id: ALLOWED_DB, title: [{ type: "text", text: { content: "Dealflow" } }] },
        ],
      });
    }
    if (method === "POST" && path === `/v1/databases/${ALLOWED_DB}/query`) {
      return json(200, { results: [notionPage(ALLOWED_PAGE, ALLOWED_DB)], has_more: false, next_cursor: null });
    }
    if (method === "GET" && path === `/v1/databases/${ALLOWED_DB}`) {
      return json(200, {
        id: ALLOWED_DB,
        title: [{ type: "text", text: { content: "Running Deals" } }],
        properties: {
          Name: { id: "title", type: "title", title: {} },
          Stage: { id: "stage", type: "select", select: { options: [{ name: "Pre-Seed" }, { name: "Seed" }] } },
          Status: { id: "status", type: "status", status: { options: [{ name: "Tracking" }, { name: "Due Diligence" }] } },
          Raise: { id: "raise", type: "number", number: {} },
        },
      });
    }
    if (method === "GET" && path === `/v1/pages/${ALLOWED_PAGE}`) return json(200, notionPage(ALLOWED_PAGE, ALLOWED_DB));
    if (method === "GET" && path === `/v1/pages/${OTHER_PAGE}`) return json(200, notionPage(OTHER_PAGE, OTHER_DB));
    if (method === "POST" && path === "/v1/pages") return json(200, { id: "cccccccccccccccccccccccccccccccc", url: "https://notion.so/new" });
    if (method === "POST" && path === "/v1/file_uploads") {
      return json(200, { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", upload_url: "https://upload.notion.test/part-1", status: "pending" });
    }
    if (method === "POST" && path === "/part-1") return json(200, { status: "uploaded" });
    if (method === "GET" && path === `/v1/blocks/${ALLOWED_PAGE}/children`) {
      return json(200, {
        results: [
          { id: "block-1", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Hello body" } }] } },
          { id: "block-2", type: "child_page", child_page: { title: "Sub page" }, has_children: true },
        ],
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "PATCH" && path === `/v1/blocks/${ALLOWED_PAGE}/children`) {
      return json(200, { results: [{ id: "block-new", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "appended" } }] } }] });
    }
    if (method === "GET" && path === "/v1/users") {
      return json(200, { results: [{ id: "user-1", type: "person", name: "Ada", person: { email: "ada@houseof434.com" } }], has_more: false, next_cursor: null });
    }
    if (method === "GET" && path === "/v1/comments") {
      return json(200, { results: [{ id: "comment-1", discussion_id: "disc-1", rich_text: [{ type: "text", text: { content: "nice" } }], created_by: { id: "user-1" } }], has_more: false, next_cursor: null });
    }
    if (method === "POST" && path === "/v1/comments") return json(200, { id: "comment-2" });
    if (method === "PATCH" && (path === `/v1/pages/${ALLOWED_PAGE}` || path === `/v1/pages/${OTHER_PAGE}`)) {
      return json(200, { id: path.split("/").at(-1), url: "https://notion.so/updated" });
    }
    return json(404, { message: "not found" });
  };
}

async function createFixture() {
  const seen: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "relay-notion-internal-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const connections = new NotionConnectionStore({ dataDir, encryptionKey: TOKEN_KEY });
  await connections.save({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    workspaceName: "Fixture",
    accessToken: "secret_notion_token",
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalNotion(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
      connections,
      allowedDatabaseIds: [ALLOWED_DB],
      fetcher: notionFetcher(seen) as typeof fetch,
      fetchAttachment: async () => ({ filename: "deck.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-deck").toString("base64") }),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port, seen };
}

async function post(port: number, path: string, userId: string, agent: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, `http://127.0.0.1:${port}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(userId, agent),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

test("search narrows Notion results to id, title, and url", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_SEARCH, USER_ID, "mercury", { query: "Nakato" });
  assert.equal(status, 200);
  const results = (body as { results: Array<Record<string, unknown>> }).results;
  assert.equal(results.length, 2);
  assert.deepEqual(Object.keys(results[0]!).sort(), ["id", "object", "title", "url"]);
  assert.equal(results[0]!.title, "Nakato");
});

test("query returns rows with a usable page id", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_QUERY, USER_ID, "scout", {
    databaseId: ALLOWED_DB,
    filter: { property: "Name", title: { equals: "Nakato" } },
  });
  assert.equal(status, 200);
  const rows = (body as { rows: Array<{ id: string }> }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, ALLOWED_PAGE);
});

test("malformed ids are rejected before any Notion call", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_GET, USER_ID, "mercury", { pageId: "not-an-id" });
  assert.equal(status, 400);
  assert.ok(seen.every((entry) => !entry.includes("not-an-id")));
});

test("a disconnected user gets no Notion access", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_SEARCH, OTHER_USER_ID, "mercury", { query: "Nakato" });
  assert.equal(status, 409);
  assert.match(String((body as { error: string }).error), /not connected/);
});

test("scout may read but never write", async () => {
  const { port } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_CREATE, USER_ID, "scout", {
    databaseId: ALLOWED_DB,
    properties: { Name: { title: [{ text: { content: "X" } }] } },
  });
  assert.equal(status, 403);
});

test("mercury cannot create outside the writable allowlist", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_CREATE, USER_ID, "mercury", {
    databaseId: OTHER_DB,
    properties: { Name: { title: [{ text: { content: "X" } }] } },
  });
  assert.equal(status, 403);
  assert.ok(!seen.some((entry) => entry === "POST /v1/pages"));
});

test("mercury creates inside the allowlist", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_CREATE, USER_ID, "mercury", {
    databaseId: ALLOWED_DB,
    properties: { Name: { title: [{ text: { content: "NewCo" } }] } },
  });
  assert.equal(status, 200);
  assert.ok(typeof (body as { page: { id: string } }).page.id === "string");
});

test("update re-reads the parent: a page outside the allowlist cannot be written", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_UPDATE, USER_ID, "mercury", {
    pageId: OTHER_PAGE,
    properties: { Raise: { number: 5 } },
  });
  assert.equal(status, 403);
  assert.ok(!seen.some((entry) => entry.startsWith("PATCH")));
});

test("update inside the allowlist patches the page", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_UPDATE, USER_ID, "mercury", {
    pageId: ALLOWED_PAGE,
    properties: { Raise: { number: 5 } },
  });
  assert.equal(status, 200);
  assert.equal((body as { page: { id: string } }).page.id, ALLOWED_PAGE);
});

test("attach uploads an email attachment into an allowlisted page's files property", async () => {
  const { port, seen } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_ATTACH, USER_ID, "mercury", {
    pageId: ALLOWED_PAGE,
    property: "Deck",
    messageId: "msg-1",
    attachmentId: "att-1",
  });
  assert.equal(status, 200);
  assert.equal((body as { file: { name: string } }).file.name, "deck.pdf");
  assert.ok(seen.includes("POST /v1/file_uploads"));
  assert.ok(seen.some((entry) => entry.startsWith("PATCH /v1/pages/")));
});

test("attach refuses a page outside the writable allowlist before uploading anything", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_ATTACH, USER_ID, "mercury", {
    pageId: OTHER_PAGE,
    property: "Deck",
    messageId: "msg-1",
    attachmentId: "att-1",
  });
  assert.equal(status, 403);
  assert.ok(!seen.includes("POST /v1/file_uploads"));
});

test("a read-only agent cannot attach files", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_ATTACH, USER_ID, "scout", {
    pageId: ALLOWED_PAGE,
    property: "Deck",
    messageId: "msg-1",
    attachmentId: "att-1",
  });
  assert.equal(status, 403);
  assert.ok(!seen.includes("POST /v1/file_uploads"));
});

test("the database schema exposes property types and existing select options", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_DATABASE_GET, USER_ID, "mercury", { databaseId: ALLOWED_DB });
  assert.equal(status, 200);
  const properties = (body as { database: { title: string; properties: Record<string, { type: string; options?: string[] }> } }).database.properties;
  assert.equal((body as { database: { title: string } }).database.title, "Running Deals");
  assert.equal(properties.Stage?.type, "select");
  assert.deepEqual(properties.Stage?.options, ["Pre-Seed", "Seed"]);
  assert.equal(properties.Status?.type, "status");
  assert.deepEqual(properties.Status?.options, ["Tracking", "Due Diligence"]);
  assert.equal(properties.Raise?.type, "number");
  assert.equal(properties.Raise?.options, undefined);
});

test("the schema route rejects a malformed database id", async () => {
  const { port, seen } = await createFixture();
  const { status } = await post(port, INTERNAL_NOTION_DATABASE_GET, USER_ID, "mercury", { databaseId: "nope" });
  assert.equal(status, 400);
  assert.ok(!seen.some((entry) => entry.includes("nope")));
});

test("page content returns block summaries with text and pagination flags", async () => {
  const { port } = await createFixture();
  const { status, body } = await post(port, INTERNAL_NOTION_PAGE_CONTENT, USER_ID, "mercury", { blockId: ALLOWED_PAGE });
  assert.equal(status, 200);
  const blocks = (body as { blocks: Array<{ id: string; type: string; text?: string; hasChildren?: boolean }> }).blocks;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { id: "block-1", type: "paragraph", text: "Hello body" });
  assert.equal(blocks[1]?.type, "child_page");
  assert.equal(blocks[1]?.text, "Sub page");
  assert.equal(blocks[1]?.hasChildren, true);
});

test("users and comments read as bounded lists", async () => {
  const { port } = await createFixture();
  const users = (await post(port, INTERNAL_NOTION_USERS, USER_ID, "scout", {})).body as { users: Array<{ id: string; name?: string; email?: string }> };
  assert.deepEqual(users.users, [{ id: "user-1", type: "person", name: "Ada", email: "ada@houseof434.com" }]);
  const comments = (await post(port, INTERNAL_NOTION_COMMENTS, USER_ID, "scout", { blockId: ALLOWED_PAGE })).body as { comments: Array<{ text: string; discussionId?: string }> };
  assert.equal(comments.comments[0]?.text, "nice");
  assert.equal(comments.comments[0]?.discussionId, "disc-1");
});

test("append content writes only inside the allowlist", async () => {
  const inside = await createFixture();
  const ok = await post(inside.port, INTERNAL_NOTION_APPEND_CONTENT, USER_ID, "mercury", {
    blockId: ALLOWED_PAGE,
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "note" } }] } }],
  });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { appended: number }).appended, 1);
  assert.ok(inside.seen.includes(`PATCH /v1/blocks/${ALLOWED_PAGE}/children`));

  const outside = await createFixture();
  const refused = await post(outside.port, INTERNAL_NOTION_APPEND_CONTENT, USER_ID, "mercury", {
    blockId: OTHER_PAGE,
    children: [{ object: "block", type: "paragraph" }],
  });
  assert.equal(refused.status, 403);
  assert.ok(!outside.seen.some((entry) => entry.startsWith("PATCH /v1/blocks")));
});

test("a read-only agent cannot append, archive, or comment", async () => {
  for (const [path, payload] of [
    [INTERNAL_NOTION_APPEND_CONTENT, { blockId: ALLOWED_PAGE, children: [{ object: "block", type: "paragraph" }] }],
    [INTERNAL_NOTION_ARCHIVE, { pageId: ALLOWED_PAGE }],
    [INTERNAL_NOTION_COMMENT_ADD, { pageId: ALLOWED_PAGE, richText: "hi" }],
  ] as const) {
    const { port } = await createFixture();
    const { status } = await post(port, path, USER_ID, "scout", payload);
    assert.equal(status, 403, path);
  }
});

test("archive and comment add refuse a page outside the allowlist", async () => {
  const archive = await createFixture();
  assert.equal((await post(archive.port, INTERNAL_NOTION_ARCHIVE, USER_ID, "mercury", { pageId: OTHER_PAGE })).status, 403);
  assert.ok(!archive.seen.some((entry) => entry === `PATCH /v1/pages/${OTHER_PAGE}`));

  const comment = await createFixture();
  assert.equal((await post(comment.port, INTERNAL_NOTION_COMMENT_ADD, USER_ID, "mercury", { pageId: OTHER_PAGE, richText: "hi" })).status, 403);
  assert.ok(!comment.seen.includes("POST /v1/comments"));
});

test("archive and comment add write inside the allowlist", async () => {
  const archive = await createFixture();
  const archived = await post(archive.port, INTERNAL_NOTION_ARCHIVE, USER_ID, "mercury", { pageId: ALLOWED_PAGE });
  assert.equal(archived.status, 200);
  assert.equal((archived.body as { page: { archived: boolean } }).page.archived, true);

  const comment = await createFixture();
  const created = await post(comment.port, INTERNAL_NOTION_COMMENT_ADD, USER_ID, "mercury", { pageId: ALLOWED_PAGE, richText: "looks good" });
  assert.equal(created.status, 200);
  assert.equal((created.body as { comment: { id: string } }).comment.id, "comment-2");
});
