/** Harness browser-takeover route: dual auth, Scout-only scope, idempotent
 * hand-off to the store. Real HTTP server, no fleet state. */
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { signedActorContext } from "../relay-mcp.ts";

const CAPABILITY = "bff-capability-that-is-long-enough-for-a-shared-secret";
const ACTOR_SECRET = "test-actor-secret-that-is-long-enough-32b";
const USER = "11111111-1111-4111-8111-111111111111";
const SCOUT = "33333333-3333-4333-8333-333333333333";
const MERCURY = "22222222-2222-4222-8222-222222222222";
const THREAD = "44444444-4444-4444-8444-444444444444";

type Reply = { status: number; body: Record<string, unknown> };

let server: Server;
let baseUrl: string;
let bots: Map<string, { relayAgent: "scout" | "mercury"; ownerUserId: string }>;
let created: Array<Record<string, unknown>>;
let createReturns: { messageId: string } | null;
let routes: typeof import("./browser-takeover.ts");
let dispatchRoutes: typeof import("./table.ts")["dispatchRoutes"];

const body = (over: Record<string, unknown> = {}) => ({
  session_id: "login_1",
  generation: 1,
  title: "Sign in to linkedin.com",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

function assertion(botId = SCOUT, agent: "scout" | "mercury" = "scout"): string {
  return signedActorContext({ userId: USER, botId, threadId: THREAD, agent }, ACTOR_SECRET);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = routes.createBrowserTakeoverRoutes({
    store: { bot: (id: string) => bots.get(id) ?? null },
    capability: CAPABILITY,
    actorSecret: ACTOR_SECRET,
    create: (actor, input) => {
      created.push({ actor, input });
      return createReturns;
    },
  });
  void dispatchRoutes([route], {
    req, res, url, path: url.pathname, method: req.method ?? "GET",
    auth: { kind: "loopback", scopes: [] },
    json, readBody,
  }).then((handled) => {
    if (!handled) json(res, 404, { error: "not found" });
  }).catch((error: unknown) => {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
}

function call(options: { capability?: string; actor?: string; payload?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.capability !== undefined) headers.authorization = `Bearer ${options.capability}`;
    if (options.actor !== undefined) headers["x-relay-actor-user"] = options.actor;
    const outgoing = httpRequest(
      new URL("/api/internal/browser-takeover", baseUrl),
      { method: "POST", headers },
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
    outgoing.write(JSON.stringify(options.payload ?? body()));
    outgoing.end();
  });
}

beforeEach(async () => {
  vi.resetModules();
  routes = await import("./browser-takeover.ts");
  ({ dispatchRoutes } = await import("./table.ts"));
  bots = new Map([[SCOUT, { relayAgent: "scout", ownerUserId: USER }], [MERCURY, { relayAgent: "mercury", ownerUserId: USER }]]);
  created = [];
  createReturns = { messageId: "m1" };
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser takeover route", () => {
  it("creates one card for an authenticated Scout", async () => {
    const reply = await call({ capability: CAPABILITY, actor: assertion() });
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ message_id: "m1" });
    expect(created).toHaveLength(1);
    expect(created[0]!.input).toMatchObject({ sessionId: "login_1", generation: 1 });
  });

  it("refuses a missing or wrong capability", async () => {
    expect((await call({ actor: assertion() })).status).toBe(401);
    expect((await call({ capability: "wrong".repeat(10), actor: assertion() })).status).toBe(401);
  });

  it("refuses an invalid actor assertion", async () => {
    expect((await call({ capability: CAPABILITY, actor: "not-an-assertion" })).status).toBe(401);
  });

  it("keeps takeovers Scout-only", async () => {
    const reply = await call({ capability: CAPABILITY, actor: assertion(MERCURY, "mercury") });
    expect(reply.status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("reports a source-conversation mismatch instead of creating a card", async () => {
    createReturns = null;
    const reply = await call({ capability: CAPABILITY, actor: assertion() });
    expect(reply.status).toBe(403);
  });


  it("passes a validated one-shot screenshot to the card", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=";
    const reply = await call({ capability: CAPABILITY, actor: assertion(), payload: body({ screenshot: png }) });
    expect(reply.status).toBe(201);
    expect(created[0]!.input).toMatchObject({ screenshot: png });
  });

  it("drops a screenshot whose bytes do not match its declared type", async () => {
    const fakePng = "data:image/png;base64," + Buffer.from("not a png at all").toString("base64");
    const reply = await call({ capability: CAPABILITY, actor: assertion(), payload: body({ screenshot: fakePng }) });
    expect(reply.status).toBe(201);
    expect(created[0]!.input).not.toHaveProperty("screenshot");
  });

  it("rejects a non-image or malformed screenshot without failing the card", async () => {
    const reply = await call({ capability: CAPABILITY, actor: assertion(), payload: body({ screenshot: "javascript:alert(1)" }) });
    expect(reply.status).toBe(201);
    expect(created[0]!.input).not.toHaveProperty("screenshot");
  });

  it("rejects a malformed body", async () => {
    const reply = await call({ capability: CAPABILITY, actor: assertion(), payload: { session_id: "x" } });
    expect(reply.status).toBe(400);
  });
});
