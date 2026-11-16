import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { GitHubUserConnectionStore } from "./github-user-connections.ts";

const KEY = "11".repeat(32);
const USER = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-github-user-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new GitHubUserConnectionStore({ dataDir, encryptionKey: KEY }) };
}

test("stores one encrypted user credential and never returns token material to metadata readers", async () => {
  const { dataDir, store } = fixture();
  await store.save({
    userId: USER,
    githubUserId: 42,
    login: "octocat",
    accessToken: "ghu_access_secret",
    refreshToken: "ghr_refresh_secret",
    accessExpiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 600_000,
  });
  const tokens = await store.tokensFor(USER);
  assert.equal(tokens?.accessToken, "ghu_access_secret");
  assert.equal(tokens?.refreshToken, "ghr_refresh_secret");
  const metadata = await store.get(USER);
  assert.equal(metadata?.login, "octocat");
  assert.equal(JSON.stringify(metadata).includes("ghu_"), false);
  const file = readFileSync(join(dataDir, "github-user-connections.json"), "utf8");
  assert.equal(file.includes("ghu_access_secret"), false);
  assert.equal(file.includes("ghr_refresh_secret"), false);
});

test("a second save for the same user replaces the credential while another user stays separate", async () => {
  const { store } = fixture();
  await store.save({ userId: USER, githubUserId: 42, login: "octocat", accessToken: "first", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 600_000 });
  await store.save({ userId: USER, githubUserId: 42, login: "octocat", accessToken: "second", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 600_000 });
  await store.save({ userId: OTHER, githubUserId: 43, login: "other", accessToken: "third", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 600_000 });
  assert.equal((await store.tokensFor(USER))?.accessToken, "second");
  assert.equal((await store.tokensFor(OTHER))?.accessToken, "third");
});

test("a wrong key fails closed, reauth is explicit, and delete removes only that user", async () => {
  const { dataDir, store } = fixture();
  await store.save({ userId: USER, githubUserId: 42, login: "octocat", accessToken: "secret", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 600_000 });
  const wrong = new GitHubUserConnectionStore({ dataDir, encryptionKey: "22".repeat(32) });
  await assert.rejects(() => wrong.tokensFor(USER), /authentication failed|Invalid/);
  await store.markReauthRequired(USER);
  assert.equal((await store.get(USER))?.reauthRequired, true);
  assert.equal(await store.delete(USER), "deleted");
  assert.equal(await store.get(USER), undefined);
});
