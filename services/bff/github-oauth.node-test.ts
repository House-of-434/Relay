import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubAppGateway } from "./github-api.ts";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";

function gateway(fetcher: typeof fetch) {
  return new GitHubAppGateway({ appId: "12345", privateKey: PRIVATE_KEY, fetcher });
}

test("exchanges a user OAuth code for an access and refresh token", async () => {
  let seen: { url: string; body: string; contentType: string } | undefined;
  const app = gateway(async (input, init) => {
    const url = String(input);
    seen = { url, body: String(init?.body ?? ""), contentType: new Headers(init?.headers).get("content-type") ?? "" };
    return Response.json({
      access_token: "ghu_access",
      refresh_token: "ghr_refresh",
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    });
  });
  const tokens = await app.exchangeUserCode({
    clientId: "Iv1.client",
    clientSecret: "secret",
    code: "code-123",
    redirectUri: "https://relay.example/api/github/callback",
    codeVerifier: "verifier",
  });
  assert.equal(tokens.accessToken, "ghu_access");
  assert.equal(tokens.refreshToken, "ghr_refresh");
  assert.equal(tokens.accessExpiresAt > Date.now(), true);
  assert.equal(seen?.url, "https://github.com/login/oauth/access_token");
  assert.equal(seen?.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(seen?.body ?? "");
  assert.equal(form.get("code"), "code-123");
  assert.equal(form.get("code_verifier"), "verifier");
  assert.equal(form.get("client_id"), "Iv1.client");
});

test("refreshes a user token with grant_type=refresh_token", async () => {
  let body = "";
  const app = gateway(async (_input, init) => {
    body = String(init?.body ?? "");
    return Response.json({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28_800 });
  });
  const tokens = await app.refreshUserToken({ clientId: "Iv1.client", clientSecret: "secret", refreshToken: "ghr_old" });
  assert.equal(tokens.accessToken, "ghu_new");
  assert.equal(tokens.refreshToken, "ghr_new");
  const form = new URLSearchParams(body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "ghr_old");
});

test("reads the user identity with a user access token", async () => {
  let authorization = "";
  const app = gateway(async (input, init) => {
    assert.equal(String(input), "https://api.github.com/user");
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ id: 42, login: "octocat" });
  });
  assert.deepEqual(await app.getUser("ghu_user"), { id: 42, login: "octocat" });
  assert.equal(authorization, "Bearer ghu_user");
});
