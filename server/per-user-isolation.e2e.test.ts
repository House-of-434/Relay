// Per-user workspace isolation, through the real server.
//
// Two signed-in accounts (A and B) with distinct Supabase UUIDs, a pairing
// session with no user id, and an admin-scope session with no user id. The
// acceptance criterion for the per-user ship: each account sees only its own
// three seeded agents, chats, rooms and records; a pairing or admin session
// with no owner sees nothing; an ownerless or system:relay record is visible
// to no one.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

const USER_A = randomUUID();
const USER_B = randomUUID();
const OWNERLESS = randomUUID();
const SYSTEM = randomUUID();

let child: ChildProcess;
let home: string;
let data: string;
let log = "";
const tokens: Record<string, string> = {};

const api = async (method: string, path: string, body?: unknown, as?: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function start() {
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, RELAY_PORT: String(PORT), RELAY_WEBHOOK_PORT: String(PORT + 1),
      // A hosted server: a local request without a session is service-trust,
      // never the owner. It must get no data.
      RELAY_LOOPBACK_TRUST: "service",
      RELAY_TEST_INTERNAL_CAPABILITY_KEY: "per-user-isolation-capability",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const botNames = (body: any): string[] => (body.bots ?? []).map((bot: any) => bot.name).sort();

posixOnly("per-user workspace isolation", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "relay-per-user-"));
    data = join(home, ".relay");
    mkdirSync(data, { recursive: true });
    // Two records no account owns: one plain ownerless bot, one reserved to
    // the system:relay principal. Neither may appear for any user viewer.
    writeFileSync(join(data, "bots.json"), JSON.stringify([
      { id: OWNERLESS, threadId: randomUUID(), name: "Ownerless", title: "", description: "", soul: "", soulHash: "x", notifications: true, color: "blue", unread: false, modelSelection: { instanceId: "", model: "" }, resumeCursors: {}, createdAt: Date.now(), tasks: [] },
      { id: SYSTEM, threadId: randomUUID(), name: "Support", title: "", description: "", soul: "", soulHash: "x", notifications: true, color: "blue", unread: false, modelSelection: { instanceId: "", model: "" }, resumeCursors: {}, createdAt: Date.now(), ownerUserId: "system:relay", tasks: [] },
    ]));
    // The sign-in list lets the server revalidate the two account sessions.
    // Both accounts are admins of their own workspace, so a per-bot GET is
    // reachable and the 404 it gets is ownership, not scope.
    writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: ["a@example.test", "b@example.test"] } }));
    const scopesFor = () => ["admin", "client"] as const;
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: scopesFor });
    tokens.A = registry.issue({ label: "A laptop", email: "a@example.test", userId: USER_A, scopes: ["admin", "client"] }).token;
    tokens.B = registry.issue({ label: "B laptop", email: "b@example.test", userId: USER_B, scopes: ["admin", "client"] }).token;
    tokens.pairing = registry.issue({ label: "Paired phone", scopes: ["client"] }).token;
    tokens.adminNoUser = registry.issue({ label: "Admin tool", scopes: ["admin", "client"] }).token;
    registry.close();
    await start();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("seeds exactly three agents per account, all owned by that account", async () => {
    for (const who of ["A", "B"] as const) {
      const list = await api("GET", "/api/bots", undefined, who);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(botNames(list.body)).toEqual(["Curator", "Mercury", "Scout"]);
      expect(list.body.bots.map((bot: any) => bot.relayAgent).sort()).toEqual(["curator", "mercury", "scout"]);
      expect(list.body.bots.every((bot: any) => bot.computer === "off" && bot.composio === false)).toBe(true);
      expect(new Set(list.body.bots.map((bot: any) => `${bot.modelSelection.instanceId}:${bot.modelSelection.model}`)).size).toBe(1);
      // The owner key is private wire state, never sent to a client.
      expect(list.body.bots.every((bot: any) => bot.ownerUserId === undefined)).toBe(true);
    }
  });

  it("shows one account none of another's bots, rooms, or threads", async () => {
    const aBots = (await api("GET", "/api/bots", undefined, "A")).body.bots as Array<{ id: string; threadId: string }>;
    const bList = await api("GET", "/api/bots", undefined, "B");
    const bIds = new Set((bList.body.bots as Array<{ id: string }>).map((bot) => bot.id));
    for (const bot of aBots) {
      expect(bIds.has(bot.id)).toBe(false);
      expect((await api("GET", `/api/bots/${bot.id}`, undefined, "B")).status).toBe(404);
      expect((await api("GET", `/api/threads/${bot.threadId}/messages`, undefined, "B")).status).toBe(404);
    }
  });

  it("hides an ownerless bot and a system:relay bot from every user", async () => {
    for (const who of ["A", "B"] as const) {
      const list = await api("GET", "/api/bots", undefined, who);
      const names = botNames(list.body);
      expect(names).not.toContain("Ownerless");
      expect(names).not.toContain("Support");
      expect((await api("GET", `/api/bots/${OWNERLESS}`, undefined, who)).status).toBe(404);
      expect((await api("GET", `/api/bots/${SYSTEM}`, undefined, who)).status).toBe(404);
    }
  });

  it("gives a session with no user id, or an admin session with no user id, nothing", async () => {
    for (const who of ["pairing", "adminNoUser"] as const) {
      const list = await api("GET", "/api/bots", undefined, who);
      // Either the route refuses the scope or it answers with an empty set;
      // never another account's records.
      expect([200, 403]).toContain(list.status);
      if (list.status === 200) expect(botNames(list.body)).toEqual([]);
    }
  });

  it("refuses a session-less local caller on every data route", async () => {
    // Service trust reaches liveness only; a data route is 404, not an empty
    // 200 that an unrelated change could later fill.
    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/bots`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/threads/${randomUUID()}/messages`)).status).toBe(404);
  });

  it("keeps the internal readers owner-scoped, never exposing another account", async () => {
    const aBots = (await api("GET", "/api/bots", undefined, "A")).body.bots as Array<{ id: string; threadId: string; relayAgent?: string; name: string }>;
    const scout = aBots.find((bot) => bot.relayAgent === "scout")!;
    const bBots = (await api("GET", "/api/bots", undefined, "B")).body.bots as Array<{ id: string }>;
    const mint = await fetch(`${BASE}/api/testing/internal-capability`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-test-capability": "per-user-isolation-capability" },
      body: JSON.stringify({ botId: scout.id, threadId: scout.threadId, kind: "agents" }),
    });
    const mintText = await mint.text();
    expect(mint.status, mintText).toBe(201);
    const token = (JSON.parse(mintText) as { token: string }).token;
    const internal = (path: string) => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });

    // list_bots: only this account's reachable peers.
    const agents = await internal("/api/internal/agents");
    expect(agents.status).toBe(200);
    const names = ((await agents.json()) as { bots: Array<{ id: string; name: string }> }).bots;
    const forbidden = new Set([...bBots.map((bot) => bot.id), OWNERLESS, SYSTEM]);
    expect(names.some((bot) => forbidden.has(bot.id))).toBe(false);
    expect(names.every((bot) => aBots.some((own) => own.id === bot.id))).toBe(true);

    // list_threads: own threads only, never another account's or an unowned one.
    const threads = await internal(`/api/internal/threads?fromBotId=${scout.id}`);
    expect(threads.status).toBe(200);
    const rows = ((await threads.json()) as { threads: Array<{ botId: string }> }).threads ?? [];
    expect(rows.some((row) => forbidden.has(row.botId))).toBe(false);
    expect(rows.every((row) => row.botId === scout.id)).toBe(true);

    // session_search answers, scoped to the caller's own conversations.
    const search = await internal(`/api/internal/session-search?fromBotId=${scout.id}&q=anything`);
    expect(search.status).toBe(200);
  });

  it("keeps the environment descriptor non-data", async () => {
    const res = await fetch(`${BASE}/.well-known/relay/environment`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("environmentId");
    expect(JSON.stringify(body)).not.toContain(USER_A);
    expect(JSON.stringify(body)).not.toContain(USER_B);
  });
});
