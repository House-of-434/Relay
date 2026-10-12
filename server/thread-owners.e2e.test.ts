// Thread-owner inheritance, end to end against the real harness server.
//
// Proves the wiring, not just the helper: both /api/internal/threads
// branches must stamp the child at creation, and the peer failure path must
// leave no owner row behind.
//
// Design notes:
// - No turns ever run: capability tokens are minted directly, and queued
//   delegations never drain without a turn lifecycle event. Nothing hangs,
//   nothing races.
// - The parent owner is seeded by writing thread-owners.json directly
//   (simulating a previously recorded verified send). The server lazy-loads
//   it on first use, so all seeding happens once in beforeAll, before any
//   lookup can occur. One shared fixture set serves all tests.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TEST_CAPABILITY_KEY = "thread-owners-fixture-capability";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_A_EMAIL = "owner-a@houseof434.com";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let dataDir = "";
let opener: any;
let target: any;
let lonely: any;
let opener2: any;

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

/** Fresh capability per call, so no per-turn open counter accumulates. */
const mintedToken = async (botId: string, threadId: string): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind: "agents", depth: 0 },
    { "x-relay-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const createBot = async (name: string) => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, {
    name,
    notifications: true,
    modelSelection: { instanceId: "gated", model: "claude-sonnet-5" },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const ownerRows = (): Record<string, { userId: string; email?: string }> => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "thread-owners.json"), "utf8"));
  } catch {
    return {};
  }
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  home = mkdtempSync(join(tmpdir(), "relay-thread-owners-"));
  dataDir = join(home, ".relay");
  mkdirSync(dataDir, { recursive: true });
  const gated = join(home, "gated-claude.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    threads: { maxConcurrentPerBot: 4 },
    instances: {
      gated: { driver: "claudeAgent", displayName: "Gated fixture", config: { cli: gated } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      RELAY_PORT: String(port),
      RELAY_WEBHOOK_PORT: String(port + 1),
      RELAY_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  opener = await createBot("Opener");
  target = await createBot("Target");
  lonely = await createBot("Lonely");
  opener2 = await createBot("Opener2");
  // Simulate previously recorded verified sends. The server lazy-loads this
  // file on first use, so every seed must exist before any lookup happens —
  // no owner activity occurs before the tests below. opener2 gets its own
  // empty delegation queue for the failure test.
  writeFileSync(
    join(dataDir, "thread-owners.json"),
    JSON.stringify({
      [opener.threadId]: { userId: USER_A, email: USER_A_EMAIL, at: Date.now() },
      [opener2.threadId]: { userId: USER_A, email: USER_A_EMAIL, at: Date.now() },
    }),
  );
}, 90_000);

afterAll(async () => {
  for (const bot of [opener, target, lonely, opener2].filter(Boolean)) {
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (home) await removeTempDir(home);
});

describe("thread owner inheritance at creation", () => {
  it("self-opened child inherits its owned parent", async () => {
    const token = await mintedToken(opener.id, opener.threadId);
    const opened = await api("POST", "/api/internal/threads", { title: "Research job", message: "go" }, token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(ownerRows()[opened.body.threadId]).toMatchObject({ userId: USER_A, email: USER_A_EMAIL });
  }, 60_000);

  it("peer-opened child inherits its owned parent", async () => {
    const token = await mintedToken(opener.id, opener.threadId);
    const opened = await api(
      "POST", "/api/internal/threads",
      { title: "Handoff job", message: "go", toBotId: target.id }, token,
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(ownerRows()[opened.body.threadId]).toMatchObject({ userId: USER_A, email: USER_A_EMAIL });
  }, 60_000);

  it("child of an ownerless parent stays ownerless", async () => {
    const token = await mintedToken(lonely.id, lonely.threadId);
    const opened = await api("POST", "/api/internal/threads", { title: "Orphan job", message: "go" }, token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(ownerRows()[opened.body.threadId]).toBeUndefined();
  }, 60_000);

  it("a failed peer handoff leaves no owner row", async () => {
    // Fill the delegation queue (cap 6, keyed by source thread) using a
    // dedicated opener whose queue is empty — earlier tests queued on the
    // shared opener. Nothing drains without a turn lifecycle event, and none
    // run here.
    for (let index = 0; index < 6; index++) {
      const token = await mintedToken(opener2.id, opener2.threadId);
      const opened = await api(
        "POST", "/api/internal/threads",
        { title: `Fill ${index}`, message: "go", toBotId: target.id }, token,
      );
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    }
    const before = ownerRows();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    // The seventh handoff fails after creating its thread, which is then
    // deleted. Placement-after-success means no row may remain for it.
    const token = await mintedToken(opener2.id, opener2.threadId);
    const failed = await api(
      "POST", "/api/internal/threads",
      { title: "Overflow", message: "go", toBotId: target.id }, token,
    );
    expect(failed.status).toBe(200);
    expect(String(failed.body.error ?? "")).toContain("too many handoffs");
    const after = ownerRows();
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length);
    for (const [id, row] of Object.entries(after)) {
      expect(before[id]).toEqual(row);
    }
  }, 120_000);
});
