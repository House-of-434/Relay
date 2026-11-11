/** Harness scribe-stop route: dual auth, Mercury scope, actor-owned target
 * selection, worker stop + intent retire. Real HTTP server like the join test. */
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { signedActorContext } from "../relay-mcp.ts";
import { normalizeMeetingUrlKey } from "../scribe-intents.ts";

const CAPABILITY = "bff-capability-that-is-long-enough-for-a-shared-secret";
const ACTOR_SECRET = "test-actor-secret-that-is-long-enough-32b";
const USER = "11111111-1111-4111-8111-111111111111";
const MERCURY = "22222222-2222-4222-8222-222222222222";
const SCOUT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEET = "https://meet.google.com/abc-defg-hij";

type Reply = { status: number; body: Record<string, unknown> };

let dirs: string[] = [];
let directory: string;
let server: Server;
let baseUrl: string;
let bots: Map<string, { relayAgent: "mercury" | "scout"; ownerUserId: string }>;
let scribeReady = true;
let stopped: string[];
let retired: string[];
let active: Array<{ instanceId: string; ownerUserId: string; urlKey: string; status: string }>;
let routeMod: typeof import("./scribe-stop.ts");
let dispatchRoutes: typeof import("./table.ts")["dispatchRoutes"];

function respond(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body);
}

function assertion(over: Record<string, string> = {}, secret = ACTOR_SECRET): string {
  return signedActorContext({ userId: USER, botId: MERCURY, threadId: THREAD, agent: "mercury", ...over }, secret);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = routeMod.createScribeStopRoutes({
    store: { bot: (id: string) => bots.get(id) ?? null },
    capability: CAPABILITY,
    actorSecret: ACTOR_SECRET,
    scribeReady: () => scribeReady,
    listActive: () => active,
    getIntent: (id) => active.find((i) => i.instanceId === id) ?? null,
    stopWorker: async (instanceId) => { stopped.push(instanceId); return { status: "partial" }; },
    retire: (instanceId) => { retired.push(instanceId); },
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

function call(body?: unknown, options: { capability?: string; actor?: string; rawBody?: string; method?: string; contentType?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.capability !== undefined) headers.authorization = `Bearer ${options.capability}`;
    if (options.actor !== undefined) headers["x-relay-actor-user"] = options.actor;
    headers["content-type"] = options.contentType ?? "application/json";
    const outgoing = httpRequest(
      new URL("/api/internal/scribe/stop", baseUrl),
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

const good = (over: Record<string, unknown> = {}) => ({ capability: CAPABILITY, actor: assertion(), ...over });

beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "scribe-stop-route-test-"));
  dirs.push(directory);
  process.env.RELAY_DATA_DIR = directory;
  routeMod = await import("./scribe-stop.ts");
  ({ dispatchRoutes } = await import("./table.ts"));
  bots = new Map([[MERCURY, { relayAgent: "mercury", ownerUserId: USER }]]);
  scribeReady = true;
  stopped = [];
  retired = [];
  active = [];
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { (await import("../message-db.ts")).closeMessageDb(); } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DATA_DIR;
});

describe("scribe stop route", () => {
  it("rejects wrong method, content type, and a body with no reference", async () => {
    expect((await call({ meeting_url: MEET }, { ...good(), method: "GET" })).status).toBe(405);
    expect((await call({ meeting_url: MEET }, { ...good(), contentType: "text/plain", rawBody: "{}" })).status).toBe(415);
    expect((await call({}, good())).status).toBe(400);
  });

  it("requires capability and a valid Mercury actor", async () => {
    expect((await call({ meeting_url: MEET }, { actor: assertion() })).status).toBe(401);
    expect((await call({ meeting_url: MEET }, { capability: CAPABILITY })).status).toBe(401);
    bots.set(SCOUT, { relayAgent: "scout", ownerUserId: USER });
    expect((await call({ meeting_url: MEET }, { ...good(), actor: assertion({ botId: SCOUT }) })).status).toBe(403);
  });

  it("reports not_recording when nothing live matches", async () => {
    const reply = await call({ meeting_url: MEET }, good());
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("not_recording");
    expect(stopped).toEqual([]);
  });

  it("stops the actor's armed capture by room and retires the intent", async () => {
    active = [{ instanceId: INSTANCE, ownerUserId: USER, urlKey: normalizeMeetingUrlKey("google_meet", MEET)!, status: "armed" }];
    const reply = await call({ meeting_url: MEET }, good());
    expect(reply.body).toMatchObject({ status: "stopped", instance_id: INSTANCE });
    expect(stopped).toEqual([INSTANCE]);
    expect(retired).toEqual([INSTANCE]);
  });

  it("stops by instance id, but never another user's capture", async () => {
    active = [{ instanceId: INSTANCE, ownerUserId: OTHER_USER, urlKey: normalizeMeetingUrlKey("google_meet", MEET)!, status: "armed" }];
    // Same room, but owned by someone else: not the actor's to stop.
    expect((await call({ meeting_url: MEET }, good())).body.status).toBe("not_recording");
    expect((await call({ instance_id: INSTANCE }, good())).body.status).toBe("not_recording");
    expect(stopped).toEqual([]);

    active[0]!.ownerUserId = USER;
    expect((await call({ instance_id: INSTANCE }, good())).body.status).toBe("stopped");
    expect(stopped).toEqual([INSTANCE]);
  });
});
