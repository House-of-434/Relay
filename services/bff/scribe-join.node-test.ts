import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";

import {
  handleInternalScribeJoin,
  INTERNAL_SCRIBE_JOIN,
  isInternalScribeJoinPath,
} from "./scribe-join.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const KEY = "66666666-6666-4666-8666-666666666666";
const KEY_DUP = "77777777-7777-4777-8777-777777777777";
const MEET = "https://meet.google.com/abc-defg-hij";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Signed exactly as the harness signs it. */
function actorAssertion(issuedAt = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", USER_ID, issuedAt, BOT_ID, THREAD_ID]))
    .digest("base64url");
  return JSON.stringify({ userId: USER_ID, issuedAt, botId: BOT_ID, threadId: THREAD_ID, signature });
}

interface HarnessCall {
  method: string;
  path: string;
  authorization: string | undefined;
  actor: string | undefined;
  body: unknown;
}

async function fixture(respond: (call: HarnessCall) => { status: number; body: unknown }) {
  const calls: HarnessCall[] = [];
  const harness = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        path: new URL(req.url ?? "/", "http://harness.test").pathname,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        actor: typeof req.headers["x-relay-actor-user"] === "string" ? req.headers["x-relay-actor-user"] as string : undefined,
        body: text ? JSON.parse(text) as unknown : undefined,
      });
      const out = respond(calls[calls.length - 1]!);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const harnessPort = (harness.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => {
    harness.closeAllConnections();
    harness.close(() => resolve());
  }));

  const bff = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalScribeJoin(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
      harnessBase: new URL(`http://127.0.0.1:${harnessPort}`),
      harnessCapability: CAPABILITY,
    });
  });
  await new Promise<void>((resolve) => bff.listen(0, "127.0.0.1", resolve));
  const bffPort = (bff.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => {
    bff.closeAllConnections();
    bff.close(() => resolve());
  }));

  const call = (body: unknown, init: RequestInit = {}) =>
    fetch(new URL(INTERNAL_SCRIBE_JOIN, `http://127.0.0.1:${bffPort}`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "x-relay-actor-user": actorAssertion(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...init,
    });
  return { calls, call };
}

const JOIN = { request_key: KEY, meeting_url: MEET };

test("path matcher is exact", () => {
  assert.equal(isInternalScribeJoinPath(INTERNAL_SCRIBE_JOIN), true);
  assert.equal(isInternalScribeJoinPath("/api/internal/scribe/join/extra"), false);
  assert.equal(isInternalScribeJoinPath("/api/internal/gmail/send"), false);
});

test("rejects bad capability, bad actor, method, content type, and schema", async () => {
  const { call } = await fixture(() => ({ status: 202, body: { status: "accepted", instance_id: "i1" } }));
  const assertion = actorAssertion();
  const jsonHeaders = {
    authorization: `Bearer ${CAPABILITY}`,
    "x-relay-actor-user": assertion,
    "content-type": "application/json",
  };
  const post = (body: unknown, init: RequestInit = {}) => call(body, init);

  assert.equal((await post(JOIN, { headers: { ...jsonHeaders, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await post(JOIN, { headers: { ...jsonHeaders, "x-relay-actor-user": "garbage" } })).status, 401);
  assert.equal((await post(JOIN, { method: "GET", headers: jsonHeaders, body: undefined })).status, 405);
  assert.equal((await call({}, { method: "POST", headers: { authorization: `Bearer ${CAPABILITY}`, "x-relay-actor-user": assertion, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post({ meeting_url: MEET })).status, 400);
  assert.equal((await post({ request_key: "not-a-uuid", meeting_url: MEET })).status, 400);
});

test("forwards assertion and body verbatim, returns the harness answer", async () => {
  const assertion = actorAssertion();
  const { calls, call } = await fixture(() => ({ status: 202, body: { status: "accepted", instance_id: "inst-9" } }));
  const res = await call(JOIN, {
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": assertion,
      "content-type": "application/json",
    },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "accepted", instance_id: "inst-9" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, INTERNAL_SCRIBE_JOIN);
  assert.equal(calls[0]!.authorization, `Bearer ${CAPABILITY}`);
  assert.equal(calls[0]!.actor, assertion);
  assert.deepEqual(calls[0]!.body, JOIN);
});

test("passes already_accepted and harness errors through with status", async () => {
  const { call } = await fixture((call) => {
    const key = (call.body as { request_key?: string }).request_key;
    if (key === KEY_DUP) return { status: 200, body: { status: "already_accepted", instance_id: "inst-1" } };
    return { status: 400, body: { error: "meeting host is not a supported provider" } };
  });
  const dup = await call({ request_key: KEY_DUP, meeting_url: MEET });
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { status: "already_accepted", instance_id: "inst-1" });
  const bad = await call({ request_key: KEY, meeting_url: "https://evil.example/x" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "meeting host is not a supported provider" });
});

test("harness garbage becomes a 502 without leaking", async () => {
  const { call } = await fixture(() => ({ status: 200, body: "plain-text" as never }));
  const res = await call(JOIN);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "capture request failed" });
});
