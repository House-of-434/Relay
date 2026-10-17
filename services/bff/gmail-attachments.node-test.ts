import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { GoogleApiGateway } from "./google-api.ts";
import { GoogleConnectionStore } from "./google-connections.ts";
import { handleInternalGmail, INTERNAL_GMAIL_ATTACHMENT_GET } from "./gmail-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const TOKEN_KEY = "a".repeat(64);
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function actorAssertion(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", userId, issuedAt, BOT_ID, THREAD_ID, "mercury"]))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId: BOT_ID, threadId: THREAD_ID, agent: "mercury", signature });
}

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4 deck"), Buffer.alloc(64, 0x41)]);
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x42)]);
const TEXT_BYTES = Buffer.from("just some text, not a deck");

interface AttachmentPart {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size?: number;
  bytes?: Buffer;
}

function part(attachment: AttachmentPart) {
  return {
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    body: {
      attachmentId: attachment.attachmentId,
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
    },
  };
}

function gatewayFor(messageParts: Record<string, AttachmentPart[]>, calls: string[]): GoogleApiGateway {
  const bytesById = new Map<string, Buffer>();
  for (const parts of Object.values(messageParts)) {
    for (const entry of parts) bytesById.set(entry.attachmentId, entry.bytes ?? PDF_BYTES);
  }
  const providerClient = {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => {
          calls.push(`messages.get:${id}`);
          const parts = messageParts[id];
          if (!parts) throw Object.assign(new Error("not found"), { code: 404 });
          return { data: { id, payload: { parts: parts.map(part) } } };
        },
        attachments: {
          get: async ({ messageId, id }: { messageId: string; id: string }) => {
            calls.push(`attachments.get:${messageId}:${id}`);
            const bytes = bytesById.get(id);
            if (!bytes) throw Object.assign(new Error("not found"), { code: 404 });
            return { data: { data: bytes.toString("base64url"), size: bytes.length } };
          },
        },
      },
    },
  };
  return {
    withClient: async (userId: string, _service: string, accountId: string, _scopes: readonly string[], operation: (client: unknown) => unknown) => {
      calls.push(`withClient:${userId}:${accountId}`);
      return operation(providerClient);
    },
  } as unknown as GoogleApiGateway;
}

async function createFixture(messageParts: Record<string, AttachmentPart[]>) {
  const calls: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "relay-gmail-attachments-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: TOKEN_KEY });
  await store.save({ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com", refreshToken: "refresh-token" });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalGmail(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      googleApi: gatewayFor(messageParts, calls),
      listAccounts: (userId) => store.list(userId),
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const post = async (userId: string, body: unknown) => {
    const response = await fetch(new URL(INTERNAL_GMAIL_ATTACHMENT_GET, `http://127.0.0.1:${port}`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "x-relay-actor-user": actorAssertion(userId),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { attachment?: { id: string; filename: string; mimeType: string; kind: string; size: number; data: string }; error?: string } };
  };
  return { post, calls };
}

const PDF_PART: AttachmentPart = { attachmentId: "att-pdf", filename: "deck.pdf", mimeType: "application/pdf", size: 1024, bytes: PDF_BYTES };

test("a pdf deck downloads with its kind and bytes", async () => {
  const { post } = await createFixture({ "msg-1": [PDF_PART] });
  const { status, body } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-pdf" });
  assert.equal(status, 200);
  assert.equal(body.attachment?.kind, "pdf");
  assert.equal(body.attachment?.size, PDF_BYTES.length);
  assert.ok(Buffer.from(body.attachment!.data, "base64").subarray(0, 4).toString() === "%PDF");
});

test("the same reader serves documents other than decks", async () => {
  // A request may bring any document; the reader is not deck-specific.
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word")]);
  const spreadsheet = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("sheet")]);
  const { post } = await createFixture({
    "msg-1": [
      { attachmentId: "att-docx", filename: "memo.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx },
      { attachmentId: "att-xlsx", filename: "cap.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: spreadsheet },
      { attachmentId: "att-csv", filename: "notes.csv", mimeType: "text/csv", bytes: Buffer.from("a,b\n1,2\n") },
      { attachmentId: "att-png", filename: "shot.png", mimeType: "image/png", bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]) },
    ],
  });
  assert.equal((await post(USER_ID, { messageId: "msg-1", attachmentId: "att-docx" })).body.attachment?.kind, "docx");
  assert.equal((await post(USER_ID, { messageId: "msg-1", attachmentId: "att-xlsx" })).body.attachment?.kind, "xlsx");
  assert.equal((await post(USER_ID, { messageId: "msg-1", attachmentId: "att-csv" })).body.attachment?.kind, "csv");
  assert.equal((await post(USER_ID, { messageId: "msg-1", attachmentId: "att-png" })).body.attachment?.kind, "png");
});

test("octet-stream mime is accepted when the filename and magic agree", async () => {
  const { post } = await createFixture({
    "msg-1": [{ attachmentId: "att-bin", filename: "deck.pdf", mimeType: "application/octet-stream", bytes: PDF_BYTES }],
  });
  const { status, body } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-bin" });
  assert.equal(status, 200);
  assert.equal(body.attachment?.kind, "pdf");
});

test("a spoofed mime is rejected instead of being parsed as the wrong format", async () => {
  const { post } = await createFixture({
    "msg-1": [{ attachmentId: "att-spoof", filename: "deck.pdf", mimeType: "application/pdf", bytes: ZIP_BYTES }],
  });
  const { status, body } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-spoof" });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /unsupported attachment/);
});

test("plain text is readable, not rejected as a non-document", async () => {
  const { post } = await createFixture({
    "msg-1": [{ attachmentId: "att-txt", filename: "notes.txt", mimeType: "text/plain", bytes: TEXT_BYTES }],
  });
  const { status, body } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-txt" });
  assert.equal(status, 200);
  assert.equal(body.attachment?.kind, "text");
});

test("an unrecognizable binary blob is rejected instead of returned raw", async () => {
  const blob = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.from([0x00, 0x00])]);
  const { post } = await createFixture({
    "msg-1": [{ attachmentId: "att-blob", filename: "file.bin", mimeType: "application/octet-stream", bytes: blob }],
  });
  const { status } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-blob" });
  assert.equal(status, 400);
});

test("an oversized attachment is refused before its bytes are fetched", async () => {
  const { post, calls } = await createFixture({
    "msg-1": [{ ...PDF_PART, attachmentId: "att-big", size: 26 * 1024 * 1024 }],
  });
  const { status, body } = await post(USER_ID, { messageId: "msg-1", attachmentId: "att-big" });
  assert.equal(status, 413);
  assert.match(body.error ?? "", /too large/);
  assert.ok(!calls.some((call) => call.startsWith("attachments.get")));
});

test("an attachment id from another message cannot be smuggled in", async () => {
  const { post } = await createFixture({ "msg-1": [PDF_PART], "msg-2": [] });
  const { status } = await post(USER_ID, { messageId: "msg-2", attachmentId: "att-pdf" });
  assert.equal(status, 404);
});

test("an unconnected user cannot download attachments", async () => {
  const { post } = await createFixture({ "msg-1": [PDF_PART] });
  const { status } = await post(OTHER_USER_ID, { messageId: "msg-1", attachmentId: "att-pdf" });
  assert.equal(status, 404);
});
