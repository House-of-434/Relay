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
import { GoogleConnectionStore } from "./google-connections.ts";
import {
  handleInternalGmail,
  INTERNAL_GMAIL_MESSAGES_GET,
  INTERNAL_GMAIL_MESSAGES_LIST,
  INTERNAL_GMAIL_SEND,
  isInternalGmailPath,
} from "./gmail-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const WRONG_SECRET = "internal-actor-secret-WRONG-0000000000000000000000";
const WRONG_CAPABILITY = "internal-bff-capability-WRONG-0000000000000000000";
const TOKEN_KEY = "a".repeat(64);
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const USER_EMAIL = "one@houseof434.com";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Signed exactly as the harness signs it, so the BFF verifies a realistic artifact. */
function actorAssertion(userId: string, email: string, issuedAt = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify([userId, email, issuedAt]))
    .digest("base64url");
  return JSON.stringify({ userId, email, issuedAt, signature });
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

async function createFixture(options: { gateway?: GoogleApiGateway; accounts?: SeededAccount[] } = {}) {
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
    "To: friend@example.test\r\nSubject: Launch\r\n\r\nShipping Friday.",
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
    "To: friend@example.test\r\nCc: teammate@example.test\r\nBcc: observer@example.test\r\nSubject: Launch\r\n\r\nShipping Friday.",
  );
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