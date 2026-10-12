import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_MAX_LIMIT,
  TinyFishSearchProvider,
  normalizeResults,
  normalizeRow,
  type SpawnFn,
  type SpawnOptions,
  type SpawnResult,
} from "./infra/search.js";

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

function searchOk(results: unknown[]): SpawnResult {
  return { exitCode: 0, stdout: JSON.stringify({ query: "q", results }), stderr: "" };
}

/** Probe succeeds; the search runs the behavior under test. */
function failingProbe(respond: (call: RecordedCall) => SpawnResult): SpawnFn & { calls: RecordedCall[] } {
  return makeSpawn((call) => {
    if (call.args[0] === "auth") return AUTH_OK;
    return respond(call);
  });
}

function providerWith(spawn: SpawnFn): TinyFishSearchProvider {
  return new TinyFishSearchProvider({ binary: "tinyfish-test", spawn });
}

test("rows narrow to exactly url, title, snippet", () => {
  assert.deepEqual(normalizeRow({ url: "https://example.com/a", title: "T", snippet: "S", position: 1, site_name: "x" }), {
    url: "https://example.com/a",
    title: "T",
    snippet: "S",
  });
  assert.equal(normalizeRow({ url: "ftp://example.com" }), null);
  assert.equal(normalizeRow({ title: "no url" }), null);
  assert.deepEqual(normalizeResults({ results: [{ url: "https://example.com", title: "", snippet: 42 }] }), [
    { url: "https://example.com", title: "https://example.com", snippet: "" },
  ]);
  assert.throws(() => normalizeResults({}), /unreadable/);
  assert.throws(() => normalizeResults(null), /unreadable/);
});

test("query maps to provider args with domain filters and client-side limit", async () => {
  const spawn = failingProbe(() =>
    searchOk([
      { url: "https://a.example/1", title: "1", snippet: "s1" },
      { url: "https://b.example/2", title: "2", snippet: "s2" },
      { url: "https://c.example/3", title: "3", snippet: "s3" },
    ]),
  );
  const provider = providerWith(spawn);
  const results = await provider.search("model release", {
    limit: 2,
    includeDomains: ["Reddit.com "],
    excludeDomains: ["spam.example"],
    language: "en",
  });
  assert.equal(results.length, 2);
  const search = spawn.calls.find((call) => call.args[0] === "search");
  assert.deepEqual(search?.args, [
    "search",
    "query",
    "model release",
    "--include-domains",
    "reddit.com",
    "--exclude-domains",
    "spam.example",
    "--language",
    "en",
  ]);
  assert.ok(!search?.args.some((arg) => arg === "--pretty"));
});

test("queries are validated before any spawn", async () => {
  const spawn = failingProbe(() => searchOk([]));
  const provider = providerWith(spawn);
  await assert.rejects(provider.search(""), /non-empty/);
  await assert.rejects(provider.search("   "), /non-empty/);
  await assert.rejects(provider.search("x".repeat(513)), /under 512/);
  assert.equal(spawn.calls.length, 0);
});

test("domain filters reject injection-shaped values", async () => {
  const spawn = failingProbe(() => searchOk([]));
  const provider = providerWith(spawn);
  await assert.rejects(provider.search("q", { includeDomains: ["a.com --pretty"] }), /bare domain names/);
  await assert.rejects(provider.search("q", { excludeDomains: ["a,b"] }), /bare domain names/);
});

test("provider failures are honest, never empty success", async () => {
  const failing = providerWith(failingProbe(() => ({ exitCode: 1, stdout: "", stderr: "quota exhausted" })));
  await assert.rejects(failing.search("q"), /quota exhausted/);

  const garbage = providerWith(failingProbe(() => ({ exitCode: 0, stdout: "not json", stderr: "" })));
  await assert.rejects(garbage.search("q"), /unreadable/);

  const jammed = providerWith(
    failingProbe(() => {
      throw new Error("web search timed out after 60000ms");
    }),
  );
  await assert.rejects(jammed.search("q"), /timed out/);
});

test("unavailable provider fails clearly at call time", async () => {
  const spawn = makeSpawn(() => ({ exitCode: 1, stdout: "", stderr: "no auth" }));
  const offline = providerWith(spawn);
  assert.equal(await offline.probe(), false);
  assert.equal(await offline.probe(), false);
  assert.equal(
    spawn.calls.filter((call) => call.args[0] === "auth").length,
    1,
  );
  await assert.rejects(offline.search("q"), /unavailable on this host/);
});

test("CLI environment carries the key and never telemetry", () => {
  const keyed = new TinyFishSearchProvider({ apiKey: "sk-test", spawn: makeSpawn(() => AUTH_OK) });
  const env = keyed.baseEnv();
  assert.equal(env.TINYFISH_API_KEY, "sk-test");
  assert.equal(env.TINYFISH_NO_TELEMETRY, "1");
  assert.ok(!("TINYFISH_DEBUG" in env));
  assert.ok(!("HOME" in env));

  const homed = new TinyFishSearchProvider({ home: "/home/op", spawn: makeSpawn(() => AUTH_OK) });
  assert.equal(homed.baseEnv().HOME, "/home/op");
});

test("limit clamps to the provider maximum", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ url: `https://example.com/${i}`, title: `${i}`, snippet: "" }));
  const spawn = failingProbe(() => searchOk(rows));
  const provider = providerWith(spawn);
  const results = await provider.search("q", { limit: 100 });
  assert.equal(results.length, SEARCH_MAX_LIMIT);
});

test("describe() reports provider status without leaking credentials", async () => {
  const offline = providerWith(makeSpawn(() => ({ exitCode: 1, stdout: "", stderr: "no auth" })));
  assert.deepEqual(await offline.describe(), {
    requestedProvider: "tinyfish",
    actualProvider: "none",
    fallbackUsed: false,
    providerStatus: "unavailable",
    errorSummary: "tinyfish CLI unavailable or unauthenticated on this host",
  });

  const online = providerWith(failingProbe(() => searchOk([])));
  assert.deepEqual(await online.describe(), {
    requestedProvider: "tinyfish",
    actualProvider: "tinyfish",
    fallbackUsed: false,
    providerStatus: "available",
  });
});

test("empty results are success, not failure", async () => {
  const spawn = failingProbe(() => searchOk([]));
  const provider = providerWith(spawn);
  assert.deepEqual(await provider.search("q"), []);
  assert.equal((await provider.describe()).providerStatus, "available");
});
