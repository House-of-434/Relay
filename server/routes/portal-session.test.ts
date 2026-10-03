import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { resolveRequestAuth, type LoopbackTrust } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { createPortalSessionRoutes } from "./portal-session.ts";
import { dispatchRoutes } from "./table.ts";

const CAPABILITY = "bff-capability-that-is-long-enough-for-a-shared-secret";
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const ISSUE_PATH = "/api/internal/portal-session";
const REVOKE_PATH = `${ISSUE_PATH}/revoke`;
const ENVIRONMENT = { environmentId: "fixture-environment", version: "test" };

type Reply = { status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };

let directory: string;
let server: Server;
let baseUrl: string;
let sessions: SessionRegistry;
let hosted = true;
let trust: LoopbackTrust = "service";
let now: number;

function respond(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const gate = resolveRequestAuth(req, {
    sessions,
    cookieName: "fixture-session",
    streamPath: "/api/events",
    url,
    loopbackTrust: trust,
  });
  if (!gate.auth) return respond(res, gate.status, { error: gate.error });
  const route = createPortalSessionRoutes({
    sessions,
    capability: CAPABILITY,
    sharedWorkspace: () => hosted,
    environment: () => ENVIRONMENT,
  });
  void dispatchRoutes([route], {
    req,
    res,
    url,
    path: url.pathname,
    method: req.method ?? "GET",
    auth: gate.auth,
    json,
    readBody,
  }).then((handled) => {
    if (!handled) respond(res, 404, { error: "not found" });
  }).catch((error: unknown) => {
    respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
}

function call(path: string, body?: unknown, options: { capability?: string; host?: string; contentType?: string; rawBody?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.capability !== undefined) headers.authorization = `Bearer ${options.capability}`;
    if (options.host !== undefined) headers.host = options.host;
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    else if (body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";
    const outgoing = httpRequest(new URL(path, baseUrl), { method: "POST", headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {}, headers: incoming.headers });
      });
    });
    outgoing.on("error", reject);
    if (options.rawBody !== undefined) outgoing.write(options.rawBody);
    else if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

function identity(overrides: Record<string, unknown> = {}) {
  return { userId: USER_ID, email: "person@example.test", scopes: ["client"], ...overrides };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "omb-portal-session-"));
  now = 1_700_000_000_000;
  sessions = new SessionRegistry({ file: join(directory, "sessions.json"), now: () => now, portalMembership: true });
  hosted = true;
  trust = "service";
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessions.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("internal portal session routes", () => {
  it("requires the dedicated capability as well as a loopback peer", async () => {
    expect((await call(ISSUE_PATH, identity())).status).toBe(401);
    expect((await call(ISSUE_PATH, identity(), { capability: `${CAPABILITY}-wrong` })).status).toBe(401);
    expect((await call(ISSUE_PATH, identity(), { capability: CAPABILITY, host: "remote.example.test" })).status).toBe(403);

    trust = "owner";
    expect((await call(ISSUE_PATH, identity())).status).toBe(401);
    const allowed = await call(ISSUE_PATH, identity(), { capability: CAPABILITY });
    expect(allowed.status).toBe(200);
    expect(sessions.authenticate(String(allowed.body.token))).toMatchObject({ userId: USER_ID });
  });

  it("refuses issuance when hosted-workspace mode is off", async () => {
    hosted = false;
    const response = await call(ISSUE_PATH, identity(), { capability: CAPABILITY });
    expect(response.status).toBe(404);
    expect(sessions.list()).toEqual([]);
  });

  it("never issues a portal session the session model would refuse", async () => {
    // index.ts derives the route gate and the session model's portal membership
    // from one authority. When they disagree the browser signs in successfully
    // and is then locked out, which is what a local deployment did before the
    // two were joined.
    for (const enabled of [false, true]) {
      hosted = enabled;
      sessions = new SessionRegistry({
        file: join(directory, `sessions-${enabled}.json`),
        now: () => now,
        portalMembership: enabled,
      });
      const response = await call(ISSUE_PATH, identity(), { capability: CAPABILITY });
      if (!enabled) {
        expect(response.status).toBe(404);
        expect(sessions.list()).toEqual([]);
        continue;
      }
      expect(response.status).toBe(200);
      expect(sessions.authenticate(String(response.body.token))).toMatchObject({
        userId: USER_ID,
        membershipAuthority: "portal",
      });
    }
  });

  it("issues a client-only session with the supplied user id and public environment data", async () => {
    const secondUserId = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
    const first = await call(ISSUE_PATH, identity({ scopes: ["admin"] }), { capability: CAPABILITY });
    const second = await call(ISSUE_PATH, identity({ userId: secondUserId }), { capability: CAPABILITY });

    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(["environment", "session", "token"]);
    expect(first.body.environment).toEqual(ENVIRONMENT);
    expect(first.body.token).toMatch(/^omb_sess_[A-Za-z0-9_-]{43}$/);
    expect(first.body.session).toMatchObject({ email: "person@example.test", scopes: ["client"] });
    expect(first.body.session).not.toHaveProperty("userId");
    expect(sessions.authenticate(String(first.body.token))).toMatchObject({ userId: USER_ID, email: "person@example.test" });
    expect(sessions.authenticate(String(second.body.token))).toMatchObject({ userId: secondUserId, email: "person@example.test" });
  });

  it.each([
    ["malformed user id", identity({ userId: "not-a-uuid" })],
    ["malformed scopes", identity({ scopes: ["owner"] })],
    ["empty scopes", identity({ scopes: [] })],
  ])("rejects %s", async (_description, body) => {
    const response = await call(ISSUE_PATH, body, { capability: CAPABILITY });
    expect(response.status).toBe(400);
    expect(sessions.list()).toEqual([]);
  });

  it("validates JSON content type and syntax", async () => {
    expect((await call(ISSUE_PATH, identity(), { capability: CAPABILITY, contentType: "text/plain" })).status).toBe(415);
    expect((await call(ISSUE_PATH, undefined, { capability: CAPABILITY, contentType: "application/json", rawBody: "{" })).status).toBe(400);
  });

  it("revokes by opaque token or session id using the same capability", async () => {
    const issuedByToken = await call(ISSUE_PATH, identity(), { capability: CAPABILITY });
    const token = String(issuedByToken.body.token);
    const revokeToken = await call(REVOKE_PATH, { token }, { capability: CAPABILITY });
    expect(revokeToken.status).toBe(200);
    expect(revokeToken.body).toEqual({ ok: true, revoked: true });
    expect(revokeToken.body).not.toHaveProperty("token");
    expect(sessions.authenticate(token)).toBeNull();

    const issuedById = await call(ISSUE_PATH, identity(), { capability: CAPABILITY });
    const session = issuedById.body.session as { id: string };
    const revokeId = await call(REVOKE_PATH, { sessionId: session.id }, { capability: CAPABILITY });
    expect(revokeId.status).toBe(200);
    expect(revokeId.body).toEqual({ ok: true, revoked: true });
    expect(sessions.authenticate(String(issuedById.body.token))).toBeNull();

    const ordinary = sessions.issue({ label: "ordinary", scopes: ["client"] });
    const refused = await call(REVOKE_PATH, { sessionId: ordinary.session.id }, { capability: CAPABILITY });
    expect(refused.body).toEqual({ ok: true, revoked: false });
    expect(sessions.authenticate(ordinary.token)).not.toBeNull();
  });
});
