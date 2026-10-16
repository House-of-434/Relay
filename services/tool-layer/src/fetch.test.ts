import assert from "node:assert/strict";
import test from "node:test";

import {
  FETCH_MAX_CHARS,
  TinyFishFetchProvider,
  normalizeFetchResult,
} from "./infra/fetch.js";
import type { SpawnFn, SpawnOptions, SpawnResult } from "./infra/tinyfish.js";

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

const AUTH_OK: SpawnResult = { exitCode: 0, stdout: JSON.stringify({ authenticated: true }), stderr: "" };

function fetchOk(row: Record<string, unknown>): SpawnResult {
  return { exitCode: 0, stdout: JSON.stringify({ results: [row], errors: [] }), stderr: "" };
}

/** Probe succeeds; the fetch runs the behavior under test. */
function withProbe(respond: (call: RecordedCall) => SpawnResult): SpawnFn & { calls: RecordedCall[] } {
  return makeSpawn((call) => (call.args[0] === "auth" ? AUTH_OK : respond(call)));
}

test("fetch narrows to the agent contract and filters links", () => {
  const normalized = normalizeFetchResult(
    { results: [{ url: "https://example.com/a", final_url: "https://example.com/b", title: "", format: "markdown", text: "Hello", links: ["https://x.test/1", "ftp://bad", 42] }] },
    "https://requested.test",
    "markdown",
  );
  assert.equal(normalized.url, "https://example.com/b");
  assert.equal(normalized.title, "https://example.com/b");
  assert.equal(normalized.text, "Hello");
  assert.deepEqual(normalized.links, ["https://x.test/1"]);
  assert.equal(normalized.truncated, false);
});

test("fetch falls back to the requested url and renders json trees", () => {
  const tree = { type: "document", children: [] };
  const normalized = normalizeFetchResult({ results: [{ format: "json", text: tree }] }, "https://requested.test", "markdown");
  assert.equal(normalized.url, "https://requested.test");
  assert.equal(normalized.format, "json");
  assert.equal(normalized.text, JSON.stringify(tree));
});

test("empty results fail clearly with the provider error", () => {
  assert.throws(
    () => normalizeFetchResult({ results: [], errors: [{ url: "https://x.test", error: "selector_not_matched" }] }, "https://x.test", "markdown"),
    /selector_not_matched/,
  );
  assert.throws(() => normalizeFetchResult({ results: [] }, "https://x.test", "markdown"), /no content/);
  assert.throws(() => normalizeFetchResult(null, "https://x.test", "markdown"), /unreadable/);
});

test("rows without usable text fail instead of returning empty success", () => {
  assert.throws(
    () => normalizeFetchResult({ results: [{ url: "https://x.test", title: "T" }] }, "https://x.test", "markdown"),
    /no content/,
  );
  assert.throws(
    () => normalizeFetchResult({ results: [{ url: "https://x.test", title: "T", text: "" }] }, "https://x.test", "markdown"),
    /no content/,
  );
  assert.throws(
    () => normalizeFetchResult({ results: [{ url: "https://x.test", title: "T", text: 42 }] }, "https://x.test", "markdown"),
    /no content/,
  );
});

test("long text is truncated and flagged", () => {
  const normalized = normalizeFetchResult(
    { results: [{ url: "https://x.test", title: "T", text: "a".repeat(FETCH_MAX_CHARS + 10) }] },
    "https://x.test",
    "markdown",
  );
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.text.length, FETCH_MAX_CHARS);
});

test("url maps to provider args with format and links", async () => {
  const spawn = withProbe(() => fetchOk({ url: "https://example.com", title: "T", text: "body" }));
  const provider = new TinyFishFetchProvider({ binary: "tinyfish-test", spawn });
  const result = await provider.fetch("https://example.com/page", { links: true });
  assert.equal(result.text, "body");
  const call = spawn.calls.find((entry) => entry.args[0] === "fetch");
  assert.deepEqual(call?.args, ["fetch", "content", "get", "--format", "markdown", "--links", "https://example.com/page"]);
});

test("urls are validated before any spawn", async () => {
  const spawn = withProbe(() => fetchOk({ url: "https://x.test", title: "T", text: "b" }));
  const provider = new TinyFishFetchProvider({ spawn });
  await assert.rejects(provider.fetch("ftp://x"), /http\(s\) URL/);
  await assert.rejects(provider.fetch(`https://x.test/${"a".repeat(3000)}`), /under 2048/);
  assert.equal(spawn.calls.length, 0);
});

test("provider failures are honest, never empty success", async () => {
  const failing = new TinyFishFetchProvider({ spawn: withProbe(() => ({ exitCode: 1, stdout: "", stderr: "quota exhausted" })) });
  await assert.rejects(failing.fetch("https://example.com/a"), /quota exhausted/);

  const garbage = new TinyFishFetchProvider({ spawn: withProbe(() => ({ exitCode: 0, stdout: "not json", stderr: "" })) });
  await assert.rejects(garbage.fetch("https://example.com/a"), /unreadable/);

  const offline = new TinyFishFetchProvider({ spawn: makeSpawn(() => ({ exitCode: 1, stdout: "", stderr: "no auth" })) });
  await assert.rejects(offline.fetch("https://example.com/a"), /unavailable on this host/);
});

test("the CLI environment never carries telemetry", () => {
  const keyed = new TinyFishFetchProvider({ apiKey: "sk-test", spawn: makeSpawn(() => AUTH_OK) });
  const env = keyed.baseEnv();
  assert.equal(env.TINYFISH_API_KEY, "sk-test");
  assert.equal(env.TINYFISH_NO_TELEMETRY, "1");
  assert.ok(!("TINYFISH_DEBUG" in env));
});
