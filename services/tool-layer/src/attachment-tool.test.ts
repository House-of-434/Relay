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
