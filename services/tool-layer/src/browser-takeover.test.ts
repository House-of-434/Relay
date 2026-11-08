import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BrowserTakeoverRequestError,
  RelayBrowserTakeoverClient,
  takeoverRequestKey,
} from "./infra/browser-takeover.js";

const ACTOR = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("takeoverRequestKey is a stable UUID per session and generation", () => {
  const key = takeoverRequestKey(ACTOR, "login_1", 1);
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(key, takeoverRequestKey(ACTOR, "login_1", 1));
  assert.notEqual(key, takeoverRequestKey(ACTOR, "login_1", 2));
  assert.notEqual(key, takeoverRequestKey(ACTOR, "login_2", 1));
});

test("the client posts card metadata with both auth headers", async () => {
  let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
  const client = new RelayBrowserTakeoverClient({
    bffInternalUrl: "http://bff.test",
    capability: "x".repeat(40),
    fetcher: async (input, init) => {
      seen = {
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ message_id: "m1" }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.requestCard("assertion", {
    requestKey: takeoverRequestKey(ACTOR, "login_1", 1),
    sessionId: "login_1",
    generation: 1,
    title: "Sign in",
    description: "Sign in to linkedin.com",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.messageId, "m1");
  assert.equal(seen!.url, "http://bff.test/api/internal/browser-takeover/request");
  assert.match(seen!.headers.authorization, /^Bearer /);
  assert.equal(seen!.headers["x-relay-actor-user"], "assertion");
});

test("the client carries the optional one-shot screenshot", async () => {
  let body: Record<string, unknown> = {};
  const client = new RelayBrowserTakeoverClient({
    bffInternalUrl: "http://bff.test",
    capability: "x".repeat(40),
    fetcher: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message_id: "m1" }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  await client.requestCard("assertion", {
    requestKey: takeoverRequestKey(ACTOR, "login_1", 1),
    sessionId: "login_1",
    generation: 1,
    title: "Sign in",
    description: "d",
    expiresAt: "2026-01-01T00:00:00.000Z",
    screenshot: "data:image/png;base64,iVBORw0KGgo=",
  });
  assert.equal(body.screenshot, "data:image/png;base64,iVBORw0KGgo=");
});

test("the client omits the screenshot when capture failed", async () => {
  let body: Record<string, unknown> = {};
  const client = new RelayBrowserTakeoverClient({
    bffInternalUrl: "http://bff.test",
    capability: "x".repeat(40),
    fetcher: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message_id: "m1" }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  await client.requestCard("assertion", {
    requestKey: takeoverRequestKey(ACTOR, "login_2", 1),
    sessionId: "login_2",
    generation: 1,
    title: "Sign in",
    description: "d",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal("screenshot" in body, false);
});

test("the client surfaces the BFF error without inventing success", async () => {
  const client = new RelayBrowserTakeoverClient({
    bffInternalUrl: "http://bff.test",
    capability: "x".repeat(40),
    fetcher: async () => new Response(JSON.stringify({ error: "source conversation does not belong to sender" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => client.requestCard("assertion", {
      requestKey: takeoverRequestKey(ACTOR, "login_1", 1),
      sessionId: "login_1",
      generation: 1,
      title: "Sign in",
      description: "d",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }),
    (error: unknown) => error instanceof BrowserTakeoverRequestError && error.status === 403,
  );
});
