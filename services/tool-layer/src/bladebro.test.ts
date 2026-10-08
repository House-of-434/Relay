import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BLADE_URL_MAX_LENGTH,
  BROWSER_RESULT_BUDGET,
  BladeBrowserPool,
  assertHttpUrl,
  assertSafeArgs,
  type SpawnFn,
  type SpawnOptions,
  type SpawnResult,
} from "./infra/bladebro.js";

const ALICE = "123e4567-e89b-42d3-a456-426614174000";
const BOB = "123e4567-e89b-42d3-a456-426614174001";

const ROOT = mkdtempSync(join(tmpdir(), "blade-pool-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

interface RecordedCall {
  binary: string;
  args: string[];
  env: Record<string, string>;
}

function makeSpawn(respond: (call: RecordedCall) => SpawnResult): SpawnFn & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (binary: string, args: string[], options: SpawnOptions): Promise<SpawnResult> => {
    const call = { binary, args, env: options.env };
    calls.push(call);
    return respond(call);
  };
  return Object.assign(fn, { calls });
}

function okJson(text: string): SpawnResult {
  return { exitCode: 0, stdout: JSON.stringify({ ok: true, is_error: false, text }), stderr: "" };
}

/** Spawn calls minus the --version probe every pool runs first. */
function bladeCalls(spawn: ReturnType<typeof makeSpawn>): RecordedCall[] {
  return spawn.calls.filter((call) => call.args[0] !== "--version");
}

/** Probe succeeds; the real command runs the failure mode under test. */
function failingProbe(respond: (call: RecordedCall) => SpawnResult): SpawnFn & { calls: RecordedCall[] } {
  return makeSpawn((call) => (call.args[0] === "--version" ? okJson("bladebro v9") : respond(call)));
}

function poolWith(spawn: SpawnFn, options: Record<string, unknown> = {}): BladeBrowserPool {
  return new BladeBrowserPool({ dataRoot: join(ROOT, "blade"), binary: "bladebro-test", spawn, ...options });
}

test("workspace resolves from the actor, never from arguments", () => {
  const pool = poolWith(makeSpawn(() => okJson("x")));
  assert.equal(pool.workspaceFor(ALICE), join(ROOT, "blade", ALICE));
  assert.throws(() => pool.workspaceFor(null), /authenticated/);
  assert.throws(() => pool.workspaceFor("../escape"), /UUID/);
});

test("daemon environment is curated, contained, and complete", () => {
  const spawn = makeSpawn(() => okJson("x"));
  const pool = poolWith(spawn, { chromePath: "/chrome", proxy: "http://proxy:8080", timezone: "Asia/Kathmandu" });
  const env = pool.buildEnv(join(ROOT, "blade", ALICE), false);
  assert.equal(env.BLADE_HOME, join(ROOT, "blade", ALICE));
  assert.equal(env.HOME, join(ROOT, "blade", ALICE));
  assert.equal(env.BLADE_NO_UPDATE_CHECK, "1");
  assert.equal(env.BLADE_CONSENT, "reject");
  assert.equal(env.CHROME_PATH, "/chrome");
  assert.equal(env.BLADE_PROXY, "http://proxy:8080");
  assert.equal(env.BLADE_TZ, "Asia/Kathmandu");
  assert.ok(!("BLADE_FRESH" in env));
  for (const key of ["BLADE_LANE", "BLADE_RB_DEBUG", "BLADE_TRANSPORT", "BLADE_RB"]) {
    assert.ok(!(key in env), `${key} must never cross into daemon env`);
  }
  const freshEnv = pool.buildEnv(join(ROOT, "blade", ALICE), true);
  assert.equal(freshEnv.BLADE_FRESH, "1");
});

test("open navigates by URL and returns bounded text", async () => {
  const spawn = makeSpawn(() => okJson("page text"));
  const pool = poolWith(spawn);
  const result = await pool.open(ALICE, "https://example.com/a");
  assert.equal(result.text, "page text");
  assert.equal(result.artifact, undefined);
  assert.deepEqual(spawn.calls.at(-1)?.args, ["nav", "https://example.com/a", "--json"]);
  assert.equal(spawn.calls.at(-1)?.env.BLADE_HOME, join(ROOT, "blade", ALICE));
});

test("read maps modes to see commands; find requires a query", async () => {
  const spawn = makeSpawn(() => okJson("t"));
  const pool = poolWith(spawn);
  await pool.read(ALICE, "content");
  await pool.read(ALICE, "outline");
  await pool.read(ALICE, "find", "price");
  const args = bladeCalls(spawn).map((call) => call.args);
  assert.ok(args.some((argv) => argv.includes("content")));
  assert.ok(args.some((argv) => argv.includes("outline")));
  assert.deepEqual(
    args.find((argv) => argv.includes("--find")),
    ["see", "--find", "price", "--json"],
  );
  await assert.rejects(pool.read(ALICE, "find", ""), /requires a short query/);
});

test("extract navigates first when a URL is given", async () => {
  const spawn = makeSpawn(() => okJson("{}"));
  const pool = poolWith(spawn);
  await pool.extract(ALICE, "https://example.com", "auto");
  await pool.extract(ALICE, null, "links");
  const calls = bladeCalls(spawn);
  assert.deepEqual(calls[0]?.args, ["see", "extract", "auto", "https://example.com/", "--json"]);
  assert.deepEqual(calls[1]?.args, ["see", "extract", "links", "--json"]);
});

test("exit 1 surfaces bounded page state; exit 2 and timeouts fail clearly", async () => {
  const pool = poolWith(
    failingProbe(() => ({ exitCode: 1, stdout: JSON.stringify({ text: "blocked: verdict" }), stderr: "" })),
  );
  await assert.rejects(pool.open(ALICE, "https://example.com"), /blocked: verdict/);

  const misuse = poolWith(failingProbe(() => ({ exitCode: 2, stdout: "", stderr: "bad usage" })));
  await assert.rejects(misuse.open(ALICE, "https://example.com"), /misused/);

  const jammed = poolWith(
    failingProbe(() => {
      throw new Error("research browser timed out after 130000ms");
    }),
  );
  await assert.rejects(jammed.open(ALICE, "https://example.com"), /timed out/);

  const garbage = poolWith(failingProbe(() => ({ exitCode: 0, stdout: "not json", stderr: "" })));
  await assert.rejects(garbage.open(ALICE, "https://example.com"), /unreadable/);
});

test("probe caches the binary check", async () => {
  const spawn = makeSpawn(() => ({ exitCode: 0, stdout: "bladebro v9", stderr: "" }));
  const pool = poolWith(spawn);
  assert.equal(await pool.probe(), true);
  assert.equal(await pool.probe(), true);
  assert.equal(spawn.calls.length, 1);

  const missing = poolWith(makeSpawn(() => {
    throw new Error("research browser failed to start: spawn ENOENT");
  }));
  assert.equal(await missing.probe(), false);
  await assert.rejects(missing.open(ALICE, "https://example.com"), /unavailable on this host/);
});

test("urls are validated server-side", () => {
  assert.equal(assertHttpUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.throws(() => assertHttpUrl("ftp://example.com"), /http\(s\)/);
  assert.throws(() => assertHttpUrl("https://user:pass@example.com"), /credentials/);
  assert.throws(() => assertHttpUrl("not a url"), /valid URL/);
  assert.throws(() => assertHttpUrl(""), /short http/);
  assert.throws(() => assertHttpUrl(`https://example.com/${"a".repeat(BLADE_URL_MAX_LENGTH)}`), /short http/);
});

test("oversized results spill to the user's artifacts dir and page back", async () => {
  const big = "x".repeat(BROWSER_RESULT_BUDGET + 100);
  const spawn = makeSpawn(() => okJson(big));
  const pool = poolWith(spawn);
  const result = await pool.open(ALICE, "https://example.com");
  assert.ok(result.artifact);
  assert.ok(result.text.length <= BROWSER_RESULT_BUDGET + 500);
  assert.match(result.text, /browser_read with mode "artifact"/);
  const page = await pool.readArtifact(ALICE, result.artifact!);
  assert.equal(page, big.slice(0, 8000));
  await assert.rejects(pool.readArtifact(ALICE, "../../escape"), /workspace-relative|escapes/);
  await assert.rejects(pool.readArtifact(ALICE, "/abs/path"), /workspace-relative/);
  await assert.rejects(pool.readArtifact(ALICE, "missing.md"), /not found/);
});

test("daemon ceiling refuses new workspaces instead of exhausting the host", async () => {
  const spawn = makeSpawn(() => okJson("t"));
  const pool = poolWith(spawn, { maxDaemons: 1 });
  await pool.open(ALICE, "https://example.com");
  await assert.rejects(pool.open(BOB, "https://example.com"), /at capacity/);
});

test("idle workspaces are reclaimed with a graceful stop", async () => {
  let now = 0;
  const spawn = makeSpawn(() => okJson("t"));
  const pool = poolWith(spawn, { idleReclaimMs: 1000, now: () => now });
  await pool.open(ALICE, "https://example.com");
  now = 5000;
  await pool.open(BOB, "https://example.com");
  const stops = spawn.calls.filter((call) => call.args[0] === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0]?.env.BLADE_HOME, join(ROOT, "blade", ALICE));
});

test("forbidden argv never reaches the binary", () => {
  for (const banned of ["--host", "--port", "rb", "mcp", "daemon"]) {
    assert.throws(() => assertSafeArgs(["see", banned]), /forbidden/);
  }
  assertSafeArgs(["nav", "https://example.com", "--json"]);
});
