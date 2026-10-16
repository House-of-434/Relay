/** Harness scribe-join route: dual auth, Mercury scope, acceptance semantics.
 * Real HTTP server like portal-session.test.ts; DB + thread-owners isolate
 * into a temp dir per test (never the real fleet). */
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { signedActorContext } from "../relay-mcp.ts";
import { recordThreadOwner } from "../thread-owners.ts";

const CAPABILITY = "bff-capability-that-is-long-enough-for-a-shared-secret";
const ACTOR_SECRET = "test-actor-secret-that-is-long-enough-32b";
const USER = "11111111-1111-4111-8111-111111111111";
const MERCURY = "22222222-2222-4222-8222-222222222222";
const SCOUT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const KEY_1 = "66666666-6666-4666-8666-666666666666";
const KEY_2 = "77777777-7777-4777-8777-777777777777";
const MEET = "https://meet.google.com/abc-defg-hij";
const MEET_OTHER = "https://meet.google.com/xyz-uvwx-yz1";

type Reply = { status: number; body: Record<string, unknown> };

let dirs: string[] = [];
let directory: string;
let server: Server;
let baseUrl: string;
let bots: Map<string, { relayAgent: "mercury" | "scout"; ownerUserId: string }>;
let scribeReady = true;
let routes: { createScribeJoinRoutes: typeof import("./scribe-join.ts")["createScribeJoinRoutes"]; SCRIBE_JOIN_PATH: string };
let dispatchRoutes: typeof import("./table.ts")["dispatchRoutes"];

function respond(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body);
}

function assertion(over: Record<string, string> = {}, secret = ACTOR_SECRET): string {
  return signedActorContext({ userId: USER, botId: MERCURY, threadId: THREAD, ...over }, secret);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = routes.createScribeJoinRoutes({
    store: { bot: (id: string) => bots.get(id) ?? null },
    dataDir: directory,
    capability: CAPABILITY,
    actorSecret: ACTOR_SECRET,
    scribeReady: () => scribeReady,
  });
  void dispatchRoutes([route], {
    req, res, url, path: url.pathname, method: req.method ?? "GET",
    auth: { kind: "loopback", scopes: [] },
    json, readBody,
  }).then((handled) => {
    if (!handled) respond(res, 404, { error: "not found" });
  }).catch((error: unknown) => {
    respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
}

function call(body?: unknown, options: { capability?: string; actor?: string; rawBody?: string; method?: string; contentType?: string; path?: string; host?: string; forwardedFor?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.capability !== undefined) headers.authorization = `Bearer ${options.capability}`;
    if (options.actor !== undefined) headers["x-relay-actor-user"] = options.actor;
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    else headers["content-type"] = "application/json";
    if (options.host !== undefined) headers.host = options.host;
    if (options.forwardedFor !== undefined) headers["x-forwarded-for"] = options.forwardedFor;
    const outgoing = httpRequest(
      new URL(options.path ?? "/api/internal/scribe/join", baseUrl),
      { method: options.method ?? "POST", headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: incoming.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.rawBody !== undefined) outgoing.write(options.rawBody);
    else if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

const good = (over: Record<string, unknown> = {}) => ({
  capability: CAPABILITY,
  actor: assertion(),
  ...over,
});

function joinBody(over: Record<string, unknown> = {}) {
  return { request_key: KEY_1, meeting_url: MEET, ...over };
}

beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "scribe-join-route-test-"));
  dirs.push(directory);
  process.env.RELAY_DATA_DIR = directory;
  routes = await import("./scribe-join.ts");
  ({ dispatchRoutes } = await import("./table.ts"));
  bots = new Map([[MERCURY, { relayAgent: "mercury", ownerUserId: USER }]]);
  scribeReady = true;
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // SQLite keeps the database file open for the lifetime of its handle.
  // Windows will not remove a directory containing an open database, and
  // vi.resetModules() strands the global setup's handle on a stale module
  // instance — so close this file's live instance before removing.
  try {
    (await import("../message-db.ts")).closeMessageDb();
  } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DATA_DIR;
});

describe("scribe join route plumbing", () => {
  it("passes other paths through", async () => {
    const reply = await call({}, { ...good(), path: "/api/internal/other" });
    expect(reply.status).toBe(404);
  });

  it("rejects wrong method, content type, and malformed bodies", async () => {
    expect((await call({}, { ...good(), method: "GET" })).status).toBe(405);
    expect((await call({}, { ...good(), contentType: "text/plain", rawBody: "{}" })).status).toBe(415);
    expect((await call({}, { ...good(), rawBody: "{oops" })).status).toBe(400);
    expect((await call({ meeting_url: MEET }, good())).status).toBe(400);
    expect((await call({ request_key: "not-a-uuid", meeting_url: MEET }, good())).status).toBe(400);
    expect((await call({ request_key: KEY_1, meeting_url: MEET, title: "x".repeat(201) }, good())).status).toBe(400);
  });

  it("requires the capability", async () => {
    const body = joinBody();
    expect((await call(body, { actor: assertion() })).status).toBe(401);
    expect((await call(body, { capability: "wrong", actor: assertion() })).status).toBe(401);
  });

  it("requires a valid actor assertion", async () => {
    const body = joinBody();
    expect((await call(body, { capability: CAPABILITY })).status).toBe(401);
    expect((await call(body, { capability: CAPABILITY, actor: "garbage" })).status).toBe(401);
    expect((await call(body, { capability: CAPABILITY, actor: assertion({}, "wrong-secret-that-is-long-enough") })).status).toBe(401);
  });
});

describe("scribe join authorization", () => {
  it("admits only loopback callers: the BFF in this container", async () => {
    // Compose callers address the harness by container name and must use the
    // BFF route instead; the harness edge gate rejects those before this
    // handler, but the route defends itself too.
    expect((await call(joinBody(), { ...good(), host: "app:8799" })).status).toBe(403);
    expect((await call(joinBody(), { ...good(), forwardedFor: "10.0.0.9" })).status).toBe(403);
  });

  it("denies non-Mercury, unknown, and cross-workspace actors", async () => {
    bots.set(SCOUT, { relayAgent: "scout", ownerUserId: USER });
    const scout = await call(joinBody(), { ...good(), actor: assertion({ botId: SCOUT }) });
    expect(scout.status).toBe(403);
    const unknown = await call(joinBody(), { ...good(), actor: assertion({ botId: "99999999-9999-4999-8999-999999999999" }) });
    expect(unknown.status).toBe(403);
    const cross = await call(joinBody(), { ...good(), actor: assertion({ userId: OTHER_USER }) });
    expect(cross.status).toBe(403);
  });

  it("rejects non-provider and credentialed URLs", async () => {
    expect((await call(joinBody({ meeting_url: "https://evil.example/x" }), good())).status).toBe(400);
    expect((await call(joinBody({ meeting_url: "https://meet.google.com@127.0.0.1/" }), good())).status).toBe(400);
  });

  it("reports unavailable when scribe is disabled", async () => {
    scribeReady = false;
    expect((await call(joinBody(), good())).status).toBe(503);
  });
});

describe("scribe join acceptance", () => {
  it("accepts once, then reports already_accepted for retries and same-room joins", async () => {
    const first = await call(joinBody(), good());
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("accepted");
    const instance = first.body.instance_id;
    expect(typeof instance).toBe("string");

    const retry = await call(joinBody(), good());
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "already_accepted", instance_id: instance });

    const sameRoom = await call(joinBody({ request_key: KEY_2 }), good());
    expect(sameRoom.status).toBe(200);
    expect(sameRoom.body).toMatchObject({ status: "already_accepted", instance_id: instance });

    const otherRoom = await call(joinBody({ request_key: KEY_2, meeting_url: MEET_OTHER }), good());
    expect(otherRoom.status).toBe(202);
    expect(otherRoom.body.instance_id).not.toBe(instance);
  });

  it("records the requester email from the asserted thread owner", async () => {
    recordThreadOwner(directory, THREAD, USER, "owner@houseof434.com");
    const reply = await call(joinBody(), good());
    expect(reply.status).toBe(202);
    const { getScribeJoinIntent } = await import("../message-db.ts");
    const stored = getScribeJoinIntent(reply.body.instance_id as string);
    expect(stored?.organizerEmail).toBe("owner@houseof434.com");
  });

  it("accepts without organizer email when the thread has no recorded owner", async () => {
    const reply = await call(joinBody(), good());
    expect(reply.status).toBe(202);
    const { getScribeJoinIntent } = await import("../message-db.ts");
    expect(getScribeJoinIntent(reply.body.instance_id as string)?.organizerEmail).toBeNull();
  });
});
