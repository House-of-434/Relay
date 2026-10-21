import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentMcpServer } from "./mcp/agent-server.js";
import type { RelayDatabase } from "./infra/database.js";
import type { GmailAttachment, RelayGmailClient } from "./infra/gmail.js";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";

function serverFor(attachment: GmailAttachment) {
  const gmailClient = {
    async getAttachment() {
      return { account: { email: "one@example.com" }, attachment };
    },
  } as unknown as RelayGmailClient;
  const database = {} as unknown as RelayDatabase;
  return createAgentMcpServer(
    "mercury",
    { userId: USER_ID },
    database,
    { client: gmailClient, actorAssertion: "assertion" },
    undefined,
  );
}

async function readAttachment(attachment: GmailAttachment) {
  const server = serverFor(attachment);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "attachment-tool-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name: "gmail_read_attachment", arguments: { messageId: "m-1", attachmentId: "a-1" } });
  } finally {
    await client.close();
    await server.close();
  }
}

test("a document attachment returns extracted text, never an image or base64", async () => {
  const result = await readAttachment({ id: "a-1", filename: "deck.pdf", mimeType: "application/pdf", kind: "pdf", size: 10, text: "--- page 1 ---\nHello Deck", warnings: [] });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "text");
  const meta = JSON.parse(blocks[0]!.text!) as { text?: string; image?: unknown; data?: unknown };
  assert.match(meta.text ?? "", /Hello Deck/);
  assert.equal(meta.image, undefined);
  assert.equal(meta.data, undefined);
});

test("an image attachment is delivered as an image content block for vision", async () => {
  const result = await readAttachment({ id: "a-1", filename: "slide.png", mimeType: "image/png", kind: "png", size: 4, image: { mimeType: "image/png", data: "AAAA" } });
  const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "text");
  assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "AAAA" });
});

test("a scanned PDF returns the noText warning so the agent can ask", async () => {
  const result = await readAttachment({ id: "a-1", filename: "scan.pdf", mimeType: "application/pdf", kind: "pdf", size: 10, text: "--- page 1 ---", noText: true, warnings: ["no extractable text (image)"] });
  const meta = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { noText?: boolean; warnings?: string[] };
  assert.equal(meta.noText, true);
  assert.deepEqual(meta.warnings, ["no extractable text (image)"]);
});

test("an xlsx attachment returns extracted sheet text, never an image or base64", async () => {
  const result = await readAttachment({ id: "a-1", filename: "q1.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx", size: 10, text: "--- sheet 1: Q1 ---\nrep\tdeal", warnings: [] });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "text");
  const meta = JSON.parse(blocks[0]!.text!) as { text?: string; image?: unknown; data?: unknown };
  assert.match(meta.text ?? "", /--- sheet 1: Q1 ---/);
  assert.match(meta.text ?? "", /rep\tdeal/);
  assert.equal(meta.image, undefined);
  assert.equal(meta.data, undefined);
});

// ── combined read: message + attachments in one call ────────────────────

function combinedServer(message: Record<string, unknown>, seen: Array<Record<string, unknown>> = []) {
  const gmailClient = {
    async getMessage(_assertion: string, input: Record<string, unknown>) {
      seen.push(input);
      return { account: { email: "one@example.com" }, message };
    },
  } as unknown as RelayGmailClient;
  return createAgentMcpServer(
    "mercury",
    { userId: USER_ID },
    {} as unknown as RelayDatabase,
    { client: gmailClient, actorAssertion: "assertion" },
    undefined,
  );
}

async function combinedRead(message: Record<string, unknown>, args: Record<string, unknown>, seen: Array<Record<string, unknown>> = []) {
  const server = combinedServer(message, seen);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "attachment-tool-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name: "gmail_read", arguments: { messageId: "m-1", ...args } });
  } finally {
    await client.close();
    await server.close();
  }
}

test("gmail_read returns one block per requested attachment, images as image blocks", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await combinedRead({
    id: "m-1",
    subject: "Combined",
    attachments: [{ id: "a-1", filename: "deck.pdf", mimeType: "application/pdf", size: 10 }],
    attachmentContents: [
      { id: "a-1", filename: "deck.pdf", kind: "pdf", size: 10, text: "--- page 1 ---\nHello", warnings: [] },
      { id: "a-2", filename: "shot.png", kind: "png", size: 4, image: { mimeType: "image/png", data: "AAAA" } },
      { id: "a-3", skipped: "attachment not found" },
    ],
  }, { attachmentIds: ["a-1", "a-2", "a-3"] }, seen);

  // The ids travel to the BFF exactly as requested.
  assert.equal(seen[0]!.messageId, "m-1");
  assert.deepEqual(seen[0]!.attachmentIds, ["a-1", "a-2", "a-3"]);

  const blocks = result.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  // message + a-1 + a-2 meta + a-2 image + a-3 = 5 blocks.
  assert.equal(blocks.length, 5);
  const message = JSON.parse(blocks[0]!.text!) as { message: { attachmentContents?: unknown } };
  assert.equal(message.message.attachmentContents, undefined);
  assert.match(blocks[1]!.text!, /--- page 1 ---/);
  assert.deepEqual(blocks[3], { type: "image", mimeType: "image/png", data: "AAAA" });
  assert.match(blocks[4]!.text!, /attachment not found/);
});

test("gmail_read without attachmentIds sends no such field and adds no blocks", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await combinedRead({ id: "m-1", subject: "Plain" }, {}, seen);
  assert.equal(seen[0]!.messageId, "m-1");
  assert.equal("attachmentIds" in seen[0]!, false);
  const blocks = result.content as Array<{ type: string }>;
  assert.equal(blocks.length, 1);
});
