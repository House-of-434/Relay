import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ConnectorStateStore } from "./connector-state.ts";
import { GitHubConnectionStore, githubConnectionId } from "./github-connections.ts";
import type { GitHubAppGateway } from "./github-api.ts";
import { handleInternalGitHub, INTERNAL_GITHUB_ISSUES_SEARCH } from "./github-internal.ts";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR_SECRET = "internal-actor-secret-fixture-value-0000000000000000";
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const BOT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const INSTALLATION_ID = 12345;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function actorAssertion(): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", ACTOR_SECRET)
    .update(JSON.stringify(["relay-actor", USER_ID, issuedAt, BOT_ID, THREAD_ID, "scout"]))
    .digest("base64url");
  return JSON.stringify({ userId: USER_ID, issuedAt, botId: BOT_ID, threadId: THREAD_ID, agent: "scout", signature });
}

async function createFixture(items: Array<Record<string, unknown>>) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-github-internal-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const connectorState = new ConnectorStateStore({ dataDir });
  await connectorState.set(USER_ID, "github", true);
  const connections = new GitHubConnectionStore({ dataDir });
  await connections.save({
    id: githubConnectionId(INSTALLATION_ID),
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    account: "octo",
    permissions: ["contents:read"],
    createdAt: new Date().toISOString(),
  });
  const app = {
    rest: async (path: string) => {
      assert.match(path, /^\/search\/issues/);
      return { items };
    },
  } as unknown as GitHubAppGateway;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleInternalGitHub(req, res, new URL(req.url ?? "/", "http://bff.test").pathname, {
      capability: CAPABILITY,
      actorSecret: ACTOR_SECRET,
      connectorState,
      connections,
      app,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port };
}

test("issues without a usable repository are dropped instead of becoming ambiguous citations", async () => {
  const { port } = await createFixture([
    {
      number: 7,
      title: "Real issue",
      html_url: "https://github.com/octo/repo/issues/7",
      state: "open",
      repository_url: "https://api.github.com/repos/octo/repo",
    },
    { number: 42, title: "Missing repo", html_url: "https://github.com/octo/repo/issues/42", state: "open" },
    {
      number: 43,
      title: "Malformed repo",
      html_url: "https://github.com/octo/repo/issues/43",
      state: "open",
      repository_url: "not-a-repo",
    },
  ]);

  const response = await fetch(new URL(INTERNAL_GITHUB_ISSUES_SEARCH, `http://127.0.0.1:${port}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY}`,
      "x-relay-actor-user": actorAssertion(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "bug" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ number: number; repo?: string }> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.number, 7);
  assert.equal(body.items[0]!.repo, "octo/repo");
  assert.ok(body.items.every((item) => typeof item.repo === "string" && item.repo.includes("/")));
});
