import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { GOOGLE_API_SCOPE_CATALOG, type GoogleApiGateway } from "./google-api.ts";
import { minimalPdf, xlsx } from "./test-document-fixtures.ts";
import { GoogleConnectionStore } from "./google-connections.ts";
import {
  __resetGmailMessageCacheForTests,
  evictCachedGmailMessage,
  getCachedGmailMessage,
  handleInternalGmail,
  INTERNAL_GMAIL_MESSAGES_GET,
  INTERNAL_GMAIL_MESSAGES_LIST,
  INTERNAL_GMAIL_REPLY,
  INTERNAL_GMAIL_SEND,
  isInternalGmailPath,
  MESSAGE_CACHE_MAX_ENTRIES,
  MESSAGE_CACHE_TTL_MS,
  setCachedGmailMessage,
  type GmailPayloadPart,
} from "./gmail-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const WRONG_SECRET = "internal-actor-secret-WRONG-0000000000000000000000";
const WRONG_CAPABILITY = "internal-bff-capability-WRONG-0000000000000000000";
const MIRROR_CAPABILITY = "internal-mail-mirror-fixture-value-00000000000000000";
const TOKEN_KEY = "a".repeat(64);
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const USER_EMAIL = "one@houseof434.com";
const SHARED_EMAIL = "relay@houseof434.com";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

/** Signed exactly as the harness signs it, so the BFF verifies a realistic artifact. */
function actorAssertion(userId: string, _email?: string, issuedAt = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", userId, issuedAt, BOT_ID, THREAD_ID, "mercury"]))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId: BOT_ID, threadId: THREAD_ID, agent: "mercury", signature });
}

function mailRoutedAssertion(issuedAt = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", USER_ID, issuedAt, BOT_ID, THREAD_ID, "mercury", true]))
    .digest("base64url");
  return JSON.stringify({
    userId: USER_ID,
    issuedAt,
    botId: BOT_ID,
    threadId: THREAD_ID,
    agent: "mercury",
    mailRouted: true,
    signature,
  });
}

interface GmailCall {
  userId: string;
  accountId: string;
  operation: string;
  raw?: string;
}

function gmailGateway(calls: GmailCall[], behaviour: "ok" | "fail" = "ok"): GoogleApiGateway {
  const providerClient = {
    users: {
      messages: {
        list: async ({ q, maxResults }: { q?: string; maxResults?: number }) => {
          calls.push({ userId: "", accountId: "", operation: `messages.list:${q}:${maxResults}` });
          if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
          return { data: { messages: [{ id: "message-1", threadId: "thread-1" }] } };
        },
        send: async ({ requestBody }: { requestBody?: { raw?: string } }) => {
          calls.push({ userId: "", accountId: "", operation: "messages.send", raw: requestBody?.raw });
          if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
          const decoded = requestBody?.raw ? Buffer.from(requestBody.raw, "base64url").toString("utf8") : "";
          return { data: { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"], decoded } };
        },
        get: async ({ id }: { id: string }) => {
          calls.push({ userId: "", accountId: "", operation: `messages.get:${id}` });
          if (behaviour === "fail") throw new Error("provider exploded with a secret token in it");
          return {
            data: {
              id,
              threadId: "thread-1",
              snippet: "hello there",
              payload: {
                headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "someone@example.com" }],
              },
            },
          };
        },
      },
      drafts: {
        create: async () => {
          calls.push({ userId: "", accountId: "", operation: "drafts.create" });
          throw new Error("drafts.create must never be called: sends compose directly");
        },
      },
    },
  };

  return {
    withClient: async (
      userId: string,
      _service: string,
      accountId: string,
      scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => {
      calls.push({ userId, accountId, operation: `withClient:${scopes.join("+")}` });
      return operation(providerClient);
    },
  } as unknown as GoogleApiGateway;
}

interface SeededAccount {
  userId: string;
  service: "gmail" | "google-calendar";
  googleSub: string;
  email: string;
}

async function createFixture(options: {
  gateway?: GoogleApiGateway;
  accounts?: SeededAccount[];
  mailbox?: { address: string; userId: string };
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-gmail-internal-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: TOKEN_KEY });
  for (const account of options.accounts ?? []) {
    await store.save({ ...account, refreshToken: `refresh-token-for-${account.googleSub}` });
  }

  const calls: GmailCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalGmail(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      googleApi: options.gateway ?? gmailGateway(calls),
      listAccounts: (userId) => store.list(userId),
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
      mirrorCapability: MIRROR_CAPABILITY,
      ...(options.mailbox ? { mailboxAddress: options.mailbox.address, mailboxUserId: options.mailbox.userId } : {}),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, `http://127.0.0.1:${port}`), init);
  const gmail = (assertion: string, capability = CAPABILITY, body: unknown = { query: "is:unread" }) =>
    call(INTERNAL_GMAIL_MESSAGES_LIST, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "x-relay-actor-user": assertion,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  return { call, gmail, calls };
}

test("the BFF derives the mailbox from the verified actor and refuses any account named in the request", async () => {
  const { gmail, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });

  // A caller trying to name another mailbox or another user is refused outright.
  const injected = await gmail(actorAssertion(USER_ID, USER_EMAIL), CAPABILITY, {
    query: "is:unread",
    userId: OTHER_USER_ID,
    accountId: "somebody-elses-account",
  });
  assert.equal(injected.status, 400);

  const response = await gmail(actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal((JSON.parse(text) as { account: { email: string } }).account.email, "one@example.com");
  assert.equal(calls.some((call) => call.operation === "messages.list:is:unread:50"), true);
  assert.equal(calls.every((call) => call.userId === "" || call.userId === USER_ID), true);
  assert.equal(calls.every((call) => call.accountId !== "somebody-elses-account"), true);
  assert.equal(text.includes("refresh-token-for-"), false);
});

test("a wrong actor cannot reach another user's Gmail token", async () => {
  const { gmail } = await createFixture({
    accounts: [
      { userId: USER_ID, service: "gmail", googleSub: "owner-sub", email: "owner@example.com" },
      { userId: OTHER_USER_ID, service: "gmail", googleSub: "other-sub", email: "other@example.com" },
    ],
  });

  const owner = await gmail(actorAssertion(USER_ID, "owner@houseof434.com"));
  assert.equal(owner.status, 200);
  assert.equal((await owner.json() as { account: { email: string } }).account.email, "owner@example.com");

  const other = await gmail(actorAssertion(OTHER_USER_ID, "other@houseof434.com"));
  assert.equal(other.status, 200);
  assert.equal((await other.json() as { account: { email: string } }).account.email, "other@example.com");

  // Claiming another identity requires the signing secret; a bad signature is refused.
  const forged = JSON.stringify({ ...JSON.parse(actorAssertion(OTHER_USER_ID, "other@houseof434.com")), signature: "A".repeat(43) });
  assert.equal((await gmail(forged)).status, 401);
});

test("a valid signature over another user's identity is still refused", async () => {
  const { gmail } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });

  const resigned = JSON.stringify({
    ...JSON.parse(actorAssertion(OTHER_USER_ID, "other@houseof434.com")),
    signature: createHmac("sha256", WRONG_SECRET)
      .update(JSON.stringify([OTHER_USER_ID, "other@houseof434.com", Math.floor(Date.now() / 1000)]))
      .digest("base64url"),
  });
  assert.equal((await gmail(resigned)).status, 401);
});

test("missing or invalid capability is rejected before any Google work happens", async () => {
  const { gmail, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const assertion = actorAssertion(USER_ID, USER_EMAIL);

  const missing = await gmail(assertion, "");
  assert.equal(missing.status, 401);
  const wrong = await gmail(assertion, WRONG_CAPABILITY);
  assert.equal(wrong.status, 401);
  assert.equal(calls.length, 0);
});

test("an expired actor assertion is rejected", async () => {
  const { gmail } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const stale = actorAssertion(USER_ID, USER_EMAIL, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await gmail(stale)).status, 401);
});

test("unconnected and ambiguous actors fail clearly instead of guessing a mailbox", async () => {
  const unconnected = await createFixture({ accounts: [] });
  assert.equal((await unconnected.gmail(actorAssertion(USER_ID, USER_EMAIL))).status, 404);

  const ambiguous = await createFixture({
    accounts: [
      { userId: USER_ID, service: "gmail", googleSub: "first-sub", email: "first@example.com" },
      { userId: USER_ID, service: "gmail", googleSub: "second-sub", email: "second@example.com" },
    ],
  });
  assert.equal((await ambiguous.gmail(actorAssertion(USER_ID, USER_EMAIL))).status, 409);
});

test("search and read require only gmail.readonly while drafts require gmail.compose", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const headers = {
    authorization: `Bearer ${CAPABILITY}`,
    "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
    "content-type": "application/json",
  };

  await call(INTERNAL_GMAIL_MESSAGES_GET, { method: "POST", headers, body: JSON.stringify({ messageId: "message-1" }) });
  await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers,
    body: JSON.stringify({ to: ["someone@example.com"], subject: "Hi", body: "There" }),
  });

  assert.deepEqual(
    calls.filter((call) => call.operation.startsWith("withClient:")).map((call) => call.operation),
    [
      `withClient:${GOOGLE_API_SCOPE_CATALOG.gmail.read}`,
      `withClient:${GOOGLE_API_SCOPE_CATALOG.gmail.drafts}`,
    ],
  );
  assert.equal(calls.some((call) => call.operation === "drafts.send"), false);
});

test("no token or raw provider error escapes the BFF", async () => {
  const { gmail } = await createFixture({
    gateway: gmailGateway([], "fail"),
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });

  const response = await gmail(actorAssertion(USER_ID, USER_EMAIL));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes("refresh-token-for-"), false);
  assert.equal(text.includes("provider exploded"), false);
  assert.equal(text.includes("secret token"), false);
});

test("the send route dispatches exactly the confirmed content to messages.send", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: ["friend@example.test"], subject: "Launch", body: "Shipping Friday." }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { account: { email: string }; sent: { id: string }; to: string[] };
  assert.equal(body.account.email, "one@example.com");
  assert.equal(body.sent.id, "sent-1");
  assert.deepEqual(body.to, ["friend@example.test"]);

  // The composed message is built from the confirmed body and nothing else.
  const send = calls.find((call) => call.operation === "messages.send");
  assert.equal(
    send?.raw ? Buffer.from(send.raw, "base64url").toString("utf8") : undefined,
    'To: friend@example.test\r\nSubject: Launch\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nShipping Friday.',
  );
});

test("cc and bcc travel as RFC2822 headers and echo back in the response", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      cc: ["teammate@example.test"],
      bcc: ["observer@example.test"],
      subject: "Launch",
      body: "Shipping Friday.",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { to: string[]; cc: string[]; bcc: string[] };
  assert.deepEqual(body.to, ["friend@example.test"]);
  assert.deepEqual(body.cc, ["teammate@example.test"]);
  assert.deepEqual(body.bcc, ["observer@example.test"]);

  const send = calls.find((call) => call.operation === "messages.send");
  assert.equal(
    send?.raw ? Buffer.from(send.raw, "base64url").toString("utf8") : undefined,
    'To: friend@example.test\r\nCc: teammate@example.test\r\nBcc: observer@example.test\r\nSubject: Launch\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nShipping Friday.',
  );
});

test("attachments ride the completion email as base64 MIME parts", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const data = Buffer.from("report bytes").toString("base64");
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Research done",
      body: "Your deep research has finished.",
      attachments: [{ filename: "report.md", mimeType: "text/markdown", data }],
    }),
  });

  assert.equal(response.status, 200);
  const raw = Buffer.from(calls.find((call) => call.operation === "messages.send")!.raw!, "base64url").toString("utf8");
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="relay_/);
  assert.match(raw, /Content-Disposition: attachment; filename="report\.md"/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.ok(raw.includes(data), "the base64 bytes are embedded in the part");
});

test("a header-injecting filename cannot break out of its MIME part", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Hi",
      body: "There",
      attachments: [{ filename: "a\r\nX-Evil: 1.md", mimeType: "text/markdown", data: Buffer.from("x").toString("base64") }],
    }),
  });

  assert.equal(response.status, 200);
  const raw = Buffer.from(calls.find((call) => call.operation === "messages.send")!.raw!, "base64url").toString("utf8");
  // The CRLF is flattened into the quoted filename, so no injected header line
  // ever begins on its own line.
  assert.equal(/\r\nX-Evil:/.test(raw), false);
});

test("a non-address in cc is refused before anything is sent", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: ["friend@example.test"], cc: ["not an address"], subject: "Hi", body: "There" }),
  });

  assert.equal(response.status, 400);
  assert.equal(calls.some((call) => call.operation === "messages.send"), false);
});

interface ForwardPart {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size?: number;
  bytes?: Buffer;
}

/** A mailbox with real attachment parts, so the send route's forwarding
 * resolution runs end to end instead of against a stub. */
function forwardingGateway(
  calls: GmailCall[],
  messages: Record<string, ForwardPart[]>,
): GoogleApiGateway {
  const bytesById = new Map<string, Buffer>();
  for (const parts of Object.values(messages)) {
    for (const part of parts) bytesById.set(part.attachmentId, part.bytes ?? Buffer.from("forwarded bytes"));
  }
  const client = {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => {
          calls.push({ userId: "", accountId: "", operation: `messages.get:${id}` });
          const parts = messages[id];
          if (!parts) throw new Error("message not found");
          return {
            data: {
              id,
              payload: {
                parts: parts.map((part) => ({
                  filename: part.filename,
                  mimeType: part.mimeType,
                  body: { attachmentId: part.attachmentId, ...(part.size === undefined ? {} : { size: part.size }) },
                })),
              },
            },
          };
        },
        attachments: {
          get: async ({ id }: { messageId: string; id: string }) => {
            calls.push({ userId: "", accountId: "", operation: `attachments.get:${id}` });
            const bytes = bytesById.get(id);
            if (!bytes) throw new Error("attachment not found");
            return { data: { data: bytes.toString("base64url") } };
          },
        },
        send: async ({ requestBody }: { requestBody?: { raw?: string } }) => {
          calls.push({ userId: "", accountId: "", operation: "messages.send", raw: requestBody?.raw });
          return { data: { id: "sent-1", threadId: "thread-1" } };
        },
      },
    },
  };
  return {
    withClient: async (
      userId: string,
      _service: string,
      accountId: string,
      scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => {
      calls.push({ userId, accountId, operation: `withClient:${scopes.join("+")}` });
      return operation(client);
    },
  } as unknown as GoogleApiGateway;
}

test("a forwarded attachment is fetched once and rides the send as a MIME part", async () => {
  const calls: GmailCall[] = [];
  const bytes = Buffer.from("forwarded report bytes");
  const gateway = forwardingGateway(calls, {
    "message-1": [
      { attachmentId: "attachment-1", filename: "Deck.pdf", mimeType: "application/pdf", bytes },
      { attachmentId: "attachment-2", filename: "Notes.md", mimeType: "text/markdown", bytes: Buffer.from("# notes") },
    ],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [
        { messageId: "message-1", attachmentId: "attachment-1" },
        { messageId: "message-1", attachmentId: "attachment-2" },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.filter((entry) => entry.operation === "messages.get:message-1").length, 1);
  const raw = Buffer.from(calls.find((entry) => entry.operation === "messages.send")!.raw!, "base64url").toString("utf8");
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="relay_/);
  assert.match(raw, /Content-Disposition: attachment; filename="Deck\.pdf"/);
  assert.match(raw, /Content-Disposition: attachment; filename="Notes\.md"/);
  assert.ok(raw.includes(bytes.toString("base64")), "the forwarded bytes are embedded in their part");
});

test("an attachment id from another message is refused before anything is sent", async () => {
  const calls: GmailCall[] = [];
  const gateway = forwardingGateway(calls, {
    "message-1": [{ attachmentId: "attachment-1", filename: "Deck.pdf", mimeType: "application/pdf" }],
    "message-2": [],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [{ messageId: "message-2", attachmentId: "attachment-1" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /not part of that message/);
  assert.equal(calls.some((entry) => entry.operation === "messages.send"), false);
});

test("an executable attachment is refused before it is fetched", async () => {
  const calls: GmailCall[] = [];
  const gateway = forwardingGateway(calls, {
    "message-1": [{ attachmentId: "attachment-1", filename: "setup.exe", mimeType: "application/x-msdownload" }],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [{ messageId: "message-1", attachmentId: "attachment-1" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /executable attachments are not allowed/);
  assert.equal(calls.some((entry) => entry.operation === "messages.send"), false);
  assert.equal(calls.some((entry) => entry.operation === "attachments.get:attachment-1"), false);
});

test("executable filenames with trailing dots, spaces, and script extensions are refused", async () => {
  const cases: Array<{ filename: string; mimeType: string }> = [
    { filename: "setup.exe ", mimeType: "application/octet-stream" },
    { filename: "setup.exe.", mimeType: "application/octet-stream" },
    { filename: "invoice.js", mimeType: "application/javascript" },
    { filename: "invoice.vb", mimeType: "text/plain" },
  ];
  for (const [index, entry] of cases.entries()) {
    const forwardCalls: GmailCall[] = [];
    const attachmentId = `attachment-${index}`;
    const gateway = forwardingGateway(forwardCalls, {
      "message-1": [{ attachmentId, filename: entry.filename, mimeType: entry.mimeType }],
    });
    const { call } = await createFixture({
      gateway,
      accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
    });
    const response = await call(INTERNAL_GMAIL_SEND, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: ["friend@example.test"],
        subject: "Forwarding",
        body: "Here it is.",
        attachments: [{ messageId: "message-1", attachmentId }],
      }),
    });

    assert.equal(response.status, 400, `${entry.filename} must be refused`);
    assert.match((await response.json() as { error: string }).error, /executable attachments are not allowed/);
    assert.equal(forwardCalls.some((call) => call.operation === "messages.send"), false);
    assert.equal(forwardCalls.some((call) => call.operation === `attachments.get:${attachmentId}`), false);
  }
});

test("an inline executable with a trailing space is refused before sending", async () => {
  const { call, calls: inlineCalls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Hi",
      body: "There",
      attachments: [{ filename: "setup.exe ", mimeType: "application/octet-stream", data: Buffer.from("x").toString("base64") }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /executable attachments are not allowed/);
  assert.equal(inlineCalls.some((call) => call.operation === "messages.send"), false);
});

test("an extensionless generic-type attachment is refused before it is fetched", async () => {
  const calls: GmailCall[] = [];
  const gateway = forwardingGateway(calls, {
    "message-1": [{ attachmentId: "attachment-1", filename: "", mimeType: "application/octet-stream" }],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [{ messageId: "message-1", attachmentId: "attachment-1" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /cannot be verified/);
  assert.equal(calls.some((entry) => entry.operation === "messages.send"), false);
  assert.equal(calls.some((entry) => entry.operation === "attachments.get:attachment-1"), false);
});

test("several large inbound refs fail with 413 without fetching every part", async () => {
  const calls: GmailCall[] = [];
  const declared = 9 * 1024 * 1024;
  const big = Buffer.alloc(declared, 1);
  const gateway = forwardingGateway(calls, {
    "message-1": [
      { attachmentId: "attachment-1", filename: "a.pdf", mimeType: "application/pdf", size: declared, bytes: big },
      { attachmentId: "attachment-2", filename: "b.pdf", mimeType: "application/pdf", size: declared, bytes: big },
      { attachmentId: "attachment-3", filename: "c.pdf", mimeType: "application/pdf", size: declared, bytes: big },
    ],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [
        { messageId: "message-1", attachmentId: "attachment-1" },
        { messageId: "message-1", attachmentId: "attachment-2" },
        { messageId: "message-1", attachmentId: "attachment-3" },
      ],
    }),
  });

  assert.equal(response.status, 413);
  assert.match((await response.json() as { error: string }).error, /too large/);
  assert.equal(calls.some((entry) => entry.operation === "messages.send"), false);
  assert.equal(calls.filter((entry) => entry.operation.startsWith("attachments.get:")).length, 2);
});

test("a forwarded attachment over the outbound cap is refused", async () => {
  const calls: GmailCall[] = [];
  const gateway = forwardingGateway(calls, {
    "message-1": [{
      attachmentId: "attachment-1",
      filename: "Huge.pdf",
      mimeType: "application/pdf",
      size: 21 * 1024 * 1024,
    }],
  });
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Forwarding",
      body: "Here it is.",
      attachments: [{ messageId: "message-1", attachmentId: "attachment-1" }],
    }),
  });

  assert.equal(response.status, 413);
  assert.match((await response.json() as { error: string }).error, /too large/);
  assert.equal(calls.some((entry) => entry.operation === "messages.send"), false);
  assert.equal(calls.some((entry) => entry.operation === "attachments.get:attachment-1"), false);
});

test("no send or message-mutating Gmail operation is routed", () => {
  for (const path of [
    INTERNAL_GMAIL_MESSAGES_LIST,
    INTERNAL_GMAIL_MESSAGES_GET,
    INTERNAL_GMAIL_SEND,
  ]) {
    assert.equal(isInternalGmailPath(path), true);
    assert.equal(path.startsWith("/api/internal/"), true);
  }
  for (const path of [
    "/api/internal/gmail/messages/send",
    "/api/internal/gmail/drafts/send",
    "/api/internal/gmail/messages/delete",
    "/api/internal/gmail/messages/modify",
    "/api/google/connections/gmail/connect",
  ]) {
    assert.equal(isInternalGmailPath(path), false);
  }
});

test("the shared mailbox resolves to the configured account, never to the actor's own", async () => {
  const configured = await createFixture({
    accounts: [
      { userId: USER_ID, service: "gmail", googleSub: "own-sub", email: "one@example.com" },
      { userId: OTHER_USER_ID, service: "gmail", googleSub: "shared-sub", email: SHARED_EMAIL },
    ],
    mailbox: { address: SHARED_EMAIL, userId: OTHER_USER_ID },
  });

  const shared = await configured.gmail(actorAssertion(USER_ID, USER_EMAIL), CAPABILITY, {
    query: "in:inbox is:unread newer_than:1d",
    mailbox: "relay",
  });
  assert.equal(shared.status, 200);
  assert.equal((await shared.json() as { account: { email: string } }).account.email, SHARED_EMAIL);
  // The credential used is the shared owner's, not the actor's.
  const sharedCalls = configured.calls.filter((call) => call.operation.startsWith("withClient:"));
  assert.equal(sharedCalls.at(-1)?.userId, OTHER_USER_ID);

  const own = await configured.gmail(actorAssertion(USER_ID, USER_EMAIL), CAPABILITY, { query: "is:unread", mailbox: "own" });
  assert.equal(own.status, 200);
  assert.equal((await own.json() as { account: { email: string } }).account.email, "one@example.com");
  const ownCalls = configured.calls.filter((call) => call.operation.startsWith("withClient:"));
  assert.equal(ownCalls.at(-1)?.userId, USER_ID);
});

test("the shared mailbox fails closed when unconfigured or unconnected", async () => {
  const unconfigured = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "own-sub", email: "one@example.com" }],
  });
  const unavailable = await unconfigured.gmail(actorAssertion(USER_ID, USER_EMAIL), CAPABILITY, { query: "is:unread", mailbox: "relay" });
  assert.equal(unavailable.status, 404);
  assert.match(await unavailable.text(), /not configured/);

  const unconnected = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "own-sub", email: "one@example.com" }],
    mailbox: { address: SHARED_EMAIL, userId: OTHER_USER_ID },
  });
  const missing = await unconnected.gmail(actorAssertion(USER_ID, USER_EMAIL), CAPABILITY, { query: "is:unread", mailbox: "relay" });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /not connected/);
  assert.equal(unconnected.calls.some((call) => call.operation.startsWith("withClient:")), false);
});

test("a read extracts the bounded body and lists attachment metadata only", async () => {
  const bodyText = "Pitch deck attached.";
  const providerClient = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [] } }),
        get: async () => ({
          data: {
            id: "message-9",
            threadId: "thread-9",
            snippet: "Pitch deck attached.",
            payload: {
              mimeType: "multipart/mixed",
              headers: [
                { name: "From", value: "teammate@houseof434.com" },
                { name: "To", value: SHARED_EMAIL },
                { name: "Subject", value: "Pitch deck" },
              ],
              parts: [
                {
                  mimeType: "multipart/alternative",
                  parts: [
                    { mimeType: "text/plain", body: { data: Buffer.from(bodyText, "utf8").toString("base64url") } },
                    { mimeType: "text/html", body: { data: Buffer.from("<p>Pitch deck attached.</p>", "utf8").toString("base64url") } },
                  ],
                },
                { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att-1", size: 12_345 } },
              ],
            },
          },
        }),
      },
      drafts: { create: async () => { throw new Error("unused"); } },
    },
  };
  const gateway = {
    withClient: async (
      _userId: string,
      _service: string,
      _accountId: string,
      _scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => operation(providerClient),
  } as unknown as GoogleApiGateway;
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: OTHER_USER_ID, service: "gmail", googleSub: "shared-sub", email: SHARED_EMAIL }],
    mailbox: { address: SHARED_EMAIL, userId: OTHER_USER_ID },
  });

  const response = await call(INTERNAL_GMAIL_MESSAGES_GET, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({ messageId: "message-9", mailbox: "relay" }),
  });
  assert.equal(response.status, 200);
  const message = (await response.json() as {
    message: { body?: string; bodyTruncated?: boolean; attachments?: unknown[] };
  }).message;
  assert.equal(message.body, bodyText);
  assert.equal(message.bodyTruncated, undefined);
  assert.deepEqual(message.attachments, [
    { id: "att-1", filename: "deck.pdf", mimeType: "application/pdf", size: 12_345 },
  ]);
});

test("an HTML-only message falls back to stripped text", async () => {
  const providerClient = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [] } }),
        get: async () => ({
          data: {
            id: "message-10",
            threadId: "thread-10",
            snippet: "Hello",
            payload: {
              mimeType: "text/html",
              headers: [{ name: "Subject", value: "Hello" }],
              body: { data: Buffer.from("<div>Hello <b>there</b></div><script>bad()</script>", "utf8").toString("base64url") },
            },
          },
        }),
      },
      drafts: { create: async () => { throw new Error("unused"); } },
    },
  };
  const gateway = {
    withClient: async (
      _userId: string,
      _service: string,
      _accountId: string,
      _scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => operation(providerClient),
  } as unknown as GoogleApiGateway;
  const { call } = await createFixture({
    gateway,
    accounts: [{ userId: OTHER_USER_ID, service: "gmail", googleSub: "shared-sub", email: SHARED_EMAIL }],
    mailbox: { address: SHARED_EMAIL, userId: OTHER_USER_ID },
  });

  const response = await call(INTERNAL_GMAIL_MESSAGES_GET, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify({ messageId: "message-10", mailbox: "relay" }),
  });
  assert.equal(response.status, 200);
  const message = (await response.json() as { message: { body?: string } }).message;
  assert.match(message.body ?? "", /Hello/);
  assert.match(message.body ?? "", /there/);
  assert.equal(message.body?.includes("bad()"), false);
});
test("the message cache hits, expires, evicts, and isolates by mailbox", () => {
  __resetGmailMessageCacheForTests();
  const payload: GmailPayloadPart = {
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att-1", size: 10 } }],
  };
  // Miss on empty cache.
  assert.equal(getCachedGmailMessage("u1", "own", "m1", 1_000), undefined);
  setCachedGmailMessage("u1", "own", "m1", payload, 1_000);
  assert.deepEqual(getCachedGmailMessage("u1", "own", "m1", 1_000), payload);
  // Isolation: other users, mailboxes, and messages miss.
  assert.equal(getCachedGmailMessage("u2", "own", "m1", 1_000), undefined);
  assert.equal(getCachedGmailMessage("u1", "relay", "m1", 1_000), undefined);
  assert.equal(getCachedGmailMessage("u1", "own", "m2", 1_000), undefined);
  // Fresh within TTL, stale after.
  assert.deepEqual(getCachedGmailMessage("u1", "own", "m1", 1_000 + MESSAGE_CACHE_TTL_MS - 1), payload);
  assert.equal(getCachedGmailMessage("u1", "own", "m1", 1_000 + MESSAGE_CACHE_TTL_MS + 1), undefined);
  // Re-set then evict explicitly.
  setCachedGmailMessage("u1", "own", "m1", payload, 2_000);
  evictCachedGmailMessage("u1", "own", "m1");
  assert.equal(getCachedGmailMessage("u1", "own", "m1", 2_000), undefined);
  // LRU cap: filling past the limit evicts the oldest first.
  for (let index = 0; index < MESSAGE_CACHE_MAX_ENTRIES + 1; index += 1) {
    setCachedGmailMessage("u1", "own", `m-${index}`, payload, 3_000 + index);
  }
  assert.equal(getCachedGmailMessage("u1", "own", "m-0", 4_000), undefined);
  assert.deepEqual(getCachedGmailMessage("u1", "own", `m-${MESSAGE_CACHE_MAX_ENTRIES}`, 4_000), payload);
  __resetGmailMessageCacheForTests();
});

// ── combined read: attachments in the same call as the message ──────────

interface PartFixture {
  mimeType: string;
  filename?: string;
  attachmentId?: string;
  /** Inline body bytes (base64url), as Gmail returns non-attachment parts. */
  inlineData?: Buffer;
  size?: number;
  parts?: PartFixture[];
}

interface ByteFixture {
  bytes: Buffer;
  declaredSize?: number;
}

function toGmailPart(part: PartFixture): unknown {
  const body: Record<string, unknown> = {};
  if (part.attachmentId) body.attachmentId = part.attachmentId;
  if (part.inlineData) body.data = part.inlineData.toString("base64url");
  if (part.size !== undefined) body.size = part.size;
  return {
    mimeType: part.mimeType,
    ...(part.filename ? { filename: part.filename } : {}),
    body,
    ...(part.parts ? { parts: part.parts.map(toGmailPart) } : {}),
  };
}

function combinedGateway(input: {
  payloadParts: PartFixture[];
  bytesById: Record<string, ByteFixture>;
  calls: GmailCall[];
}): GoogleApiGateway {
  const providerClient = {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => {
          input.calls.push({ userId: "", accountId: "", operation: `messages.get:${id}` });
          return {
            data: {
              id,
              threadId: "thread-1",
              snippet: "combined",
              payload: {
                headers: [{ name: "Subject", value: "Combined" }],
                parts: input.payloadParts.map(toGmailPart),
              },
            },
          };
        },
        attachments: {
          get: async ({ id }: { id: string }) => {
            input.calls.push({ userId: "", accountId: "", operation: `attachments.get:${id}` });
            const fixture = input.bytesById[id];
            if (!fixture) throw new Error(`no fixture bytes for ${id}`);
            return { data: { data: fixture.bytes.toString("base64url"), size: fixture.declaredSize ?? fixture.bytes.length } };
          },
        },
      },
    },
  };
  return {
    withClient: async (
      _userId: string,
      _service: string,
      _accountId: string,
      _scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => operation(providerClient),
  } as unknown as GoogleApiGateway;
}

const COMBINED_ACCOUNTS = [{ userId: USER_ID, service: "gmail" as const, googleSub: "gmail-sub", email: "one@example.com" }];

function combinedRead(call: (path: string, init?: RequestInit) => Promise<Response>, body: unknown) {
  return call(INTERNAL_GMAIL_MESSAGES_GET, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID, USER_EMAIL),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

type CombinedBody = {
  message: {
    attachmentContents?: Array<{ id: string; kind?: string; text?: string; skipped?: string; image?: { mimeType: string; data: string } }>;
    attachments?: Array<{ id: string }>;
  };
  error?: string;
};

test("a combined read extracts every requested attachment with one messages.get", async () => {
  const calls: GmailCall[] = [];
  const pdf = minimalPdf(["Combined read"]);
  const sheet = xlsx({ Q1: [["rep", "deal"], ["amy", 7]] });
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({
      calls,
      payloadParts: [
        { mimeType: "application/pdf", filename: "deck.pdf", attachmentId: "att-pdf", size: pdf.length },
        {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          filename: "pipeline.xlsx",
          attachmentId: "att-xlsx",
          size: sheet.length,
        },
      ],
      bytesById: { "att-pdf": { bytes: pdf }, "att-xlsx": { bytes: sheet } },
    }),
  });

  const response = await combinedRead(call, { messageId: "msg-combined", attachmentIds: ["att-pdf", "att-xlsx"] });
  assert.equal(response.status, 200);
  const body = await response.json() as CombinedBody;
  const contents = body.message.attachmentContents ?? [];
  assert.equal(contents.length, 2);
  assert.match(contents[0]!.text ?? "", /--- page 1 ---/);
  assert.match(contents[0]!.text ?? "", /Combined read/);
  assert.match(contents[1]!.text ?? "", /--- sheet 1: Q1 ---/);
  assert.match(contents[1]!.text ?? "", /amy\t7/);
  // The whole point: one message fetch, not one per attachment.
  assert.equal(calls.filter((entry) => entry.operation === "messages.get:msg-combined").length, 1);
  assert.equal(calls.filter((entry) => entry.operation.startsWith("attachments.get:")).length, 2);
});

test("a combined read without attachmentIds returns metadata only, exactly as before", async () => {
  const calls: GmailCall[] = [];
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({
      calls,
      payloadParts: [{ mimeType: "application/pdf", filename: "deck.pdf", attachmentId: "att-pdf", size: 10 }],
      bytesById: { "att-pdf": { bytes: minimalPdf(["x"]) } },
    }),
  });
  const response = await combinedRead(call, { messageId: "msg-plain" });
  assert.equal(response.status, 200);
  const body = await response.json() as CombinedBody;
  assert.equal(body.message.attachments?.length, 1);
  assert.equal(body.message.attachmentContents, undefined);
  assert.equal(calls.some((entry) => entry.operation.startsWith("attachments.get:")), false);
});

test("five attachment ids are accepted and six are rejected before any Gmail call", async () => {
  const calls: GmailCall[] = [];
  const pdf = minimalPdf(["batch"]);
  const parts: PartFixture[] = Array.from({ length: 6 }, (_, index) => ({
    mimeType: "application/pdf",
    filename: `file-${index}.pdf`,
    attachmentId: `att-${index}`,
    size: pdf.length,
  }));
  const bytesById: Record<string, ByteFixture> = {};
  for (let index = 0; index < 6; index += 1) bytesById[`att-${index}`] = { bytes: pdf };
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({ calls, payloadParts: parts, bytesById }),
  });

  const five = await combinedRead(call, {
    messageId: "msg-batch",
    attachmentIds: ["att-0", "att-1", "att-2", "att-3", "att-4"],
  });
  assert.equal(five.status, 200);
  const fiveBody = await five.json() as CombinedBody;
  assert.equal(fiveBody.message.attachmentContents?.length, 5);

  const callsBefore = calls.length;
  const six = await combinedRead(call, {
    messageId: "msg-batch",
    attachmentIds: ["att-0", "att-1", "att-2", "att-3", "att-4", "att-5"],
  });
  assert.equal(six.status, 400);
  // Input validation rejects the request before touching Gmail.
  assert.equal(calls.length, callsBefore);
});

test("nested MIME attachments are found, and a part with only an inline body is not an attachment", async () => {
  const calls: GmailCall[] = [];
  const pdf = minimalPdf(["Nested"]);
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({
      calls,
      payloadParts: [
        { mimeType: "text/plain", inlineData: Buffer.from("body text") },
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/html", inlineData: Buffer.from("<p>body</p>") },
                {
                  mimeType: "multipart/related",
                  parts: [{ mimeType: "application/pdf", filename: "deep.pdf", attachmentId: "att-deep", size: pdf.length }],
                },
              ],
            },
          ],
        },
      ],
      bytesById: { "att-deep": { bytes: pdf } },
    }),
  });

  const response = await combinedRead(call, {
    messageId: "msg-nested",
    attachmentIds: ["att-deep", "not-an-attachment"],
  });
  assert.equal(response.status, 200);
  const contents = (await response.json() as CombinedBody).message.attachmentContents ?? [];
  assert.equal(contents.length, 2);
  assert.match(contents[0]!.text ?? "", /Nested/);
  // A part carrying only an inline body has no attachment id: it is not an
  // attachment and is reported as unknown rather than extracted.
  assert.equal(contents[1]!.skipped, "attachment not found");
});

test("duplicate attachment ids collapse to one extraction", async () => {
  const calls: GmailCall[] = [];
  const pdf = minimalPdf(["Once"]);
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({
      calls,
      payloadParts: [{ mimeType: "application/pdf", filename: "once.pdf", attachmentId: "att-dup", size: pdf.length }],
      bytesById: { "att-dup": { bytes: pdf } },
    }),
  });
  const response = await combinedRead(call, {
    messageId: "msg-dup",
    attachmentIds: ["att-dup", "att-dup", "att-dup"],
  });
  assert.equal(response.status, 200);
  const contents = (await response.json() as CombinedBody).message.attachmentContents ?? [];
  assert.equal(contents.length, 1);
  assert.match(contents[0]!.text ?? "", /Once/);
  assert.equal(calls.filter((entry) => entry.operation === "attachments.get:att-dup").length, 1);
});

test("one unreadable attachment never aborts the rest of the batch", async () => {
  const calls: GmailCall[] = [];
  const pdf = minimalPdf(["Still here"]);
  const { call } = await createFixture({
    accounts: COMBINED_ACCOUNTS,
    gateway: combinedGateway({
      calls,
      payloadParts: [
        { mimeType: "application/pdf", filename: "big.pdf", attachmentId: "att-big", size: 26 * 1024 * 1024 },
        { mimeType: "application/pdf", filename: "ok.pdf", attachmentId: "att-ok", size: pdf.length },
      ],
      // Deliberately no bytes for att-big: the declared size must stop it
      // before the download is attempted.
      bytesById: { "att-ok": { bytes: pdf } },
    }),
  });
  const response = await combinedRead(call, {
    messageId: "msg-mixed",
    attachmentIds: ["att-big", "missing-id", "att-ok"],
  });
  assert.equal(response.status, 200);
  const contents = (await response.json() as CombinedBody).message.attachmentContents ?? [];
  assert.equal(contents.length, 3);
  assert.match(contents[0]!.skipped ?? "", /too large/);
  assert.equal(contents[1]!.skipped, "attachment not found");
  assert.match(contents[2]!.text ?? "", /Still here/);
  assert.equal(calls.some((entry) => entry.operation === "attachments.get:att-big"), false);
});

test("the trusted reply route threads from the source Message-ID and carries the persisted Message-ID", async () => {
  let sentBody: { raw?: string; threadId?: string } | undefined;
  let sourceRequested: string | undefined;
  const gateway = {
    withClient: async (
      _userId: string,
      _service: string,
      _accountId: string,
      _scopes: readonly string[],
      operation: (client: unknown) => unknown,
    ) => operation({
      users: {
        messages: {
          get: async ({ id }: { id: string }) => {
            sourceRequested = id;
            return {
              data: {
                threadId: "gmail-thread",
                payload: {
                  headers: [
                    { name: "Message-ID", value: "<source@mail.gmail.com>" },
                    { name: "References", value: "<root@mail.gmail.com>" },
                  ],
                },
              },
            };
          },
          send: async ({ requestBody }: { requestBody?: { raw?: string; threadId?: string } }) => {
            sentBody = requestBody;
            return { data: { id: "sent-reply", threadId: "gmail-thread" } };
          },
        },
      },
    }),
  } as unknown as GoogleApiGateway;
  const { call } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: SHARED_EMAIL }],
    mailbox: { address: SHARED_EMAIL, userId: USER_ID },
    gateway,
  });

  const response = await call(INTERNAL_GMAIL_REPLY, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID),
      "x-relay-mail-mirror": `Bearer ${MIRROR_CAPABILITY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Re: Launch",
      body: "Shipping Friday.",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "source-message",
      messageId: "<relay-turn@houseof434.com>",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { account: { email: string }; sent: { id: string } };
  assert.equal(body.account.email, SHARED_EMAIL);
  assert.equal(body.sent.id, "sent-reply");
  assert.equal(sourceRequested, "source-message");
  assert.equal(sentBody?.threadId, "gmail-thread");
  const raw = Buffer.from(sentBody?.raw ?? "", "base64url").toString("utf8");
  assert.match(raw, /^To: friend@example\.test\r$/m);
  assert.match(raw, /^Subject: Re: Launch\r$/m);
  assert.match(raw, /^Message-ID: <relay-turn@houseof434\.com>\r$/m);
  assert.match(raw, /^In-Reply-To: <source@mail\.gmail\.com>\r$/m);
  assert.match(raw, /^References: <root@mail\.gmail\.com> <source@mail\.gmail\.com>\r$/m);
});

test("the reply route refuses a caller without the harness mirror capability", async () => {
  const { call } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: SHARED_EMAIL }],
    mailbox: { address: SHARED_EMAIL, userId: USER_ID },
  });

  const response = await call(INTERNAL_GMAIL_REPLY, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(USER_ID),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: ["friend@example.test"],
      subject: "Re: Launch",
      body: "Shipping Friday.",
      gmailThreadId: "gmail-thread",
    }),
  });

  assert.equal(response.status, 401);
});

test("a mail-routed assertion is refused by the agent send route before Gmail", async () => {
  const { call, calls } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });

  const response = await call(INTERNAL_GMAIL_SEND, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": mailRoutedAssertion(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: ["friend@example.test"], subject: "Launch", body: "Shipping Friday." }),
  });

  assert.equal(response.status, 403);
  assert.equal(calls.some((call) => call.operation === "messages.send"), false);
});

test("a forged or false mail marker is rejected before the send route", async () => {
  const { call } = await createFixture({
    accounts: [{ userId: USER_ID, service: "gmail", googleSub: "gmail-sub", email: "one@example.com" }],
  });
  const signed = JSON.parse(mailRoutedAssertion()) as Record<string, unknown>;
  const falseMarker = { ...signed, mailRouted: false };
  const extraMarker = { ...signed, extra: true };

  for (const assertion of [falseMarker, extraMarker]) {
    const response = await call(INTERNAL_GMAIL_SEND, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "x-relay-actor-user": JSON.stringify(assertion),
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: ["friend@example.test"], subject: "Launch", body: "Shipping Friday." }),
    });
    assert.equal(response.status, 401);
  }
});
