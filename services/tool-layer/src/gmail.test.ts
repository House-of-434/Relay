import assert from "node:assert/strict";
import { test } from "node:test";

import { GMAIL_INTERNAL_PATHS, GmailRequestError, RelayGmailClient } from "./infra/gmail.js";
import { GMAIL_PERMISSIONS, authorizeGmail } from "./domain/permissions.js";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR = '{"userId":"1457cb2a-7543-4b48-8854-a63cd160241f","email":"one@houseof434.com"}';

test("only Mercury may use Gmail, including send", () => {
  assert.deepEqual([...GMAIL_PERMISSIONS.mercury].sort(), ["read", "search", "send"]);
  assert.deepEqual(GMAIL_PERMISSIONS.scout, []);
  assert.deepEqual(GMAIL_PERMISSIONS.curator, []);

  for (const capability of ["search", "read", "send"] as const) {
    assert.doesNotThrow(() => authorizeGmail("mercury", capability));
  }
  assert.throws(() => authorizeGmail("scout", "search"), /search access denied for scout/);
  assert.throws(() => authorizeGmail("curator", "read"), /read access denied for curator/);

  // Sending is Mercury-only and scout/curator are denied it.
  assert.throws(() => authorizeGmail("scout", "send"), /send access denied for scout/);
  assert.throws(() => authorizeGmail("curator", "send"), /send access denied for curator/);
});

test("the Gmail client forwards the actor assertion and capability, never a user id", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayGmailClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return Response.json({ account: { email: "one@example.com" }, messages: [] });
    }) as typeof fetch,
  });

  await client.searchMessages(ACTOR, { query: "is:unread" });

  const headers = new Headers(seen[0]!.init.headers);
  assert.equal(seen[0]!.url, `http://127.0.0.1:8798${GMAIL_INTERNAL_PATHS.messagesList}`);
  assert.equal(headers.get("authorization"), `Bearer ${CAPABILITY}`);
  assert.equal(headers.get("x-relay-actor-user"), ACTOR);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(seen[0]!.init.method, "POST");
  assert.doesNotMatch(JSON.stringify(seen[0]!.init.body ?? ""), /userId|accountId|email/);
});

test("sendEmail forwards cc and bcc unchanged", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayGmailClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return Response.json({ account: { email: "one@example.com" }, sent: {}, to: [], cc: [], bcc: [] });
    }) as typeof fetch,
  });

  await client.sendEmail(ACTOR, {
    to: ["a@b.test"],
    cc: ["c@d.test"],
    bcc: ["e@f.test"],
    subject: "s",
    body: "b",
  });

  assert.equal(seen[0]!.url, `http://127.0.0.1:8798${GMAIL_INTERNAL_PATHS.send}`);
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), {
    to: ["a@b.test"],
    cc: ["c@d.test"],
    bcc: ["e@f.test"],
    subject: "s",
    body: "b",
  });
});

test("the Gmail client refuses to run without a usable capability", async () => {
  let called = false;
  const client = new RelayGmailClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: "too-short",
    fetcher: (async () => { called = true; return Response.json({}); }) as typeof fetch,
  });

  await assert.rejects(() => client.searchMessages(ACTOR, { query: "x" }), (error: unknown) => {
    assert.ok(error instanceof GmailRequestError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(called, false);
});

test("BFF refusals surface as errors without leaking provider detail", async () => {
  const client = new RelayGmailClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => new Response(
      JSON.stringify({ error: "Gmail is not connected for this user" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )) as typeof fetch,
  });

  await assert.rejects(() => client.getMessage(ACTOR, { messageId: "m1" }), /Gmail is not connected for this user/);
});

test("an unreachable BFF is reported as such rather than silently succeeding", async () => {
  const client = new RelayGmailClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });

  await assert.rejects(
    () => client.sendEmail(ACTOR, { to: ["a@b.test"], subject: "s", body: "b" }),
    /Gmail connector service is unreachable/,
  );
});

test("only the three Gmail paths are ever called", () => {
  assert.deepEqual(Object.values(GMAIL_INTERNAL_PATHS).sort(), [
    "/api/internal/gmail/messages/get",
    "/api/internal/gmail/messages/list",
    "/api/internal/gmail/send",
  ]);
});