import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import {
  configFromEnvironment,
  createRelayBff,
  createSupabaseJwtVerifier,
  isPermittedAvatarUrl,
  supabaseDisplayClaims,
  type RelayBffConfig,
} from "./server.ts";
import {
  GOOGLE_SERVICE_REGISTRY,
  GOOGLE_SERVICE_SCOPES,
  GoogleConnectionStore,
  parseTokenEncryptionKey,
} from "./google-connections.ts";
import { GOOGLE_API_SCOPE_CATALOG, type GoogleApiGateway } from "./google-api.ts";

const PROJECT_URL = "https://relay-fixture.supabase.test";
const ISSUER = `${PROJECT_URL}/auth/v1`;
const SUPABASE_ANON_KEY = "fixture-anon-key-do-not-forward";
const BFF_CAPABILITY = "fixture-bff-capability-that-is-at-least-32-bytes";
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const USER_EMAIL = "teammate@houseof434.com";
const ACCESS_TOKEN_SENTINEL = "supabase-access-token-must-stay-on-bff";
const RELAY_TOKEN = `relay_sess_${"R".repeat(43)}`;
const RELAY_SESSION_ID = "2457cb2a-7543-4b48-8854-a63cd160241f";
const VERIFIED_AUTH_USER = {
  id: USER_ID,
  email: USER_EMAIL,
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
};

const signingKey = await generateKeyPair("ES256");
const alternateSigningKey = await generateKeyPair("ES256");
const exportedJwk = await exportJWK(signingKey.publicKey);
const PUBLIC_JWK: JWK = { ...exportedJwk, kid: "fixture-es256", alg: "ES256", use: "sig" };

const CONFIG: RelayBffConfig = {
  supabaseProjectUrl: PROJECT_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  relayBffCapability: BFF_CAPABILITY,
  relayBffPublicUrl: "http://localhost:8798",
  bffPort: 8798,
  ombPort: 8799,
  uiPort: 5199,
};

const GOOGLE_TOKEN_KEY = Buffer.alloc(32, 0x5a).toString("base64");
const GOOGLE_CONFIG: Partial<RelayBffConfig> = {
  googleOAuthClients: {
    gmail: { clientId: "gmail-client-id", clientSecret: "gmail-client-secret" },
    "google-calendar": { clientId: "calendar-client-id", clientSecret: "calendar-client-secret" },
  },
  googleRedirectUri: "http://localhost:8798/api/google/oauth/callback",
  googleTokenEncryptionKey: GOOGLE_TOKEN_KEY,
};

interface GoogleFixtureOptions {
  exchanges?: Record<string, Record<string, unknown>>;
  userinfoByAccessToken?: Record<string, unknown>;
  defaultExchange?: Record<string, unknown>;
  defaultUserinfo?: unknown;
  tokenExchangeStatus?: number;
  revokeStatus?: number;
}

interface CapturedRequest {
  url: URL;
  init: RequestInit;
  headers: Headers;
  body: string;
}

interface Fixture {
  baseUrl: string;
  server: Server;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

interface CalendarListCall {
  userId: string;
  accountId: string;
  params: Record<string, unknown>;
}

function calendarGateway(
  list: (call: CalendarListCall) => Promise<unknown>,
  calls: CalendarListCall[],
  scopes: string[][],
  writes: string[],
): GoogleApiGateway {
  const gateway = {
    async withClient(
      userId: string,
      service: string,
      accountId: string,
      requiredScopes: readonly string[],
      operation: (client: never) => unknown,
    ) {
      if (service !== "google-calendar") throw new Error("Unexpected Google service");
      scopes.push([...requiredScopes]);
      return operation({
        events: {
          list: async (params: unknown) => {
            const call = { userId, accountId, params: params as Record<string, unknown> };
            calls.push(call);
            return list(call);
          },
          insert: () => { writes.push("insert"); },
          update: () => { writes.push("update"); },
          patch: () => { writes.push("patch"); },
          delete: () => { writes.push("delete"); },
        },
      } as never);
    },
  };
  return gateway as unknown as GoogleApiGateway;
}

const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "relay-google-connections-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureJwksFetcher(): typeof fetch {
  return async (input) => {
    assert.equal(String(input), `${ISSUER}/.well-known/jwks.json`);
    return Response.json({ keys: [PUBLIC_JWK] });
  };
}

async function accessToken(
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string | string[]; expiresAt?: number; key?: typeof signingKey } = {},
): Promise<string> {
  const { exp: _unusedExpiration, iat: _unusedIssuedAt, ...payloadClaims } = claims;
  const token = new SignJWT({
    sub: USER_ID,
    email: USER_EMAIL,
    email_verified: true,
    ...payloadClaims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "fixture-es256" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600);
  return token.sign(options.key?.privateKey ?? signingKey.privateKey);
}

function verifier(now: () => number = Date.now, profile: unknown = VERIFIED_AUTH_USER) {
  return createSupabaseJwtVerifier({
    projectUrl: PROJECT_URL,
    anonKey: SUPABASE_ANON_KEY,
    fetcher: async (input, init = {}) => {
      assert.equal(String(input), `${PROJECT_URL}/auth/v1/user`);
      assert.equal(init.method, "GET");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("apikey"), SUPABASE_ANON_KEY);
      assert.match(headers.get("authorization") ?? "", /^Bearer \S+$/);
      return Response.json(profile);
    },
    jwksFetcher: fixtureJwksFetcher(),
    now,
  });
}

/** Provider request bodies may be form-encoded or JSON; read either shape. */
function bodyField(body: string, name: string): string {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed[name] === "string" ? parsed[name] as string : "";
  }
  return new URLSearchParams(body).get(name) ?? "";
}

async function bodyString(body: BodyInit | null | undefined): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

function fixtureFetcher(
  accessTokenValue: string,
  requests: CapturedRequest[],
  authUser: unknown,
  google: GoogleFixtureOptions = {},
  alternateIdentities: Record<string, { accessToken: string; authUser: unknown }> = {},
): typeof fetch {
  const authProfiles = new Map<string, unknown>([
    [accessTokenValue, authUser],
    ...Object.values(alternateIdentities).map(({ accessToken: token, authUser: profile }) => [token, profile] as const),
  ]);
  return async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const body = await bodyString(init.body);
    requests.push({ url, init, headers: new Headers(init.headers), body });

    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const code = bodyField(body, "code");
      return Response.json(google.exchanges?.[code] ?? google.defaultExchange ?? {
        access_token: "google-access-token-must-not-leave-bff",
        refresh_token: "google-refresh-token-must-not-leave-bff",
      }, { status: google.tokenExchangeStatus ?? 200 });
    }
    if (url.origin === "https://openidconnect.googleapis.com" && url.pathname === "/v1/userinfo") {
      const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      return Response.json(google.userinfoByAccessToken?.[bearer] ?? google.defaultUserinfo ?? {
        sub: "google-sub-1",
        email: "google-user@example.com",
        email_verified: true,
      });
    }
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/revoke") {
      return new Response(null, { status: google.revokeStatus ?? 200 });
    }

    if (url.pathname === "/auth/v1/token") {
      // Supabase's PKCE exchange names the code `auth_code`, unlike Google's `code`.
      const code = bodyField(body, "auth_code");
      return Response.json({
        access_token: alternateIdentities[code]?.accessToken ?? accessTokenValue,
        refresh_token: "supabase-refresh-token-must-not-leave-bff",
      });
    }
    if (url.pathname === "/auth/v1/user") {
      const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      return Response.json(authProfiles.get(bearer) ?? authUser);
    }
    if (url.pathname === "/api/internal/portal-session") {
      return Response.json({ token: RELAY_TOKEN, session: { id: RELAY_SESSION_ID }, environment: { label: "Relay" } });
    }
    if (url.pathname === "/api/internal/portal-session/revoke") return Response.json({ ok: true, revoked: true });
    if (url.pathname === "/api/auth/logout") return Response.json({ ok: true });
    if (url.pathname === "/.well-known/relay/environment") {
      return Response.json({ environmentId: "fixture-environment", capabilities: { emailSignIn: false } });
    }
    if (url.pathname === "/api/events") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: second\n\n"));
            controller.close();
          }, 5);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("upstream response", {
        status: 200,
        headers: { "content-type": "text/plain", "set-cookie": "harness-session=must-not-reach-browser" },
      });
    }
    throw new Error("Unexpected fixture URL");
  };
}

async function startFixture(options: {
  claims?: Record<string, unknown>;
  authUser?: unknown;
  alternateLogins?: Array<{ code: string; claims: Record<string, unknown>; authUser: unknown }>;
  now?: () => number;
  sessionTtlMs?: number;
  fetcher?: typeof fetch;
  google?: GoogleFixtureOptions;
  googleApi?: GoogleApiGateway;
  dataDir?: string;
  config?: Partial<RelayBffConfig>;
} = {}): Promise<Fixture> {
  const requests: CapturedRequest[] = [];
  const token = await accessToken(options.claims);
  const alternateIdentities: Record<string, { accessToken: string; authUser: unknown }> = {};
  for (const login of options.alternateLogins ?? []) {
    alternateIdentities[login.code] = { accessToken: await accessToken(login.claims), authUser: login.authUser };
  }
  const config = {
    ...CONFIG,
    ...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...options.config,
  };
  const bff = createRelayBff({
    config,
    ...(options.googleApi ? { googleApi: options.googleApi } : {}),
    fetcher: options.fetcher ?? fixtureFetcher(
      token,
      requests,
      options.authUser ?? VERIFIED_AUTH_USER,
      options.google,
      alternateIdentities,
    ),
    jwksFetcher: fixtureJwksFetcher(),
    now: options.now,
  });
  await new Promise<void>((resolve, reject) => {
    bff.server.once("error", reject);
    bff.server.listen(0, "127.0.0.1", resolve);
  });
  const address = bff.server.address();
  if (!address || typeof address === "string") throw new Error("BFF fixture failed to bind");
  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server: bff.server,
    requests,
    close: bff.close,
  };
  fixtures.push(fixture);
  return fixture;
}

interface LoginFlow {
  authorizeUrl: URL;
  callbackUrl: URL;
  state: string;
  stateCookie: string;
  stateCookieHeader: string;
}

async function beginLogin(fixture: Fixture): Promise<LoginFlow> {
  const start = await fetch(`${fixture.baseUrl}/auth/login`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get("location")!);
  const callbackUrl = new URL(authorizeUrl.searchParams.get("redirect_to")!);
  const stateCookieHeader = start.headers.getSetCookie().find((cookie) => cookie.startsWith("relay_bff_oauth_state="));
  assert.ok(stateCookieHeader);
  const stateCookie = stateCookieHeader.split(";", 1)[0]!;
  const state = stateCookie.slice("relay_bff_oauth_state=".length);
  return {
    authorizeUrl,
    callbackUrl,
    state,
    stateCookie,
    stateCookieHeader,
  };
}

async function completeLogin(
  fixture: Fixture,
  flow: LoginFlow,
  callbackParams: Record<string, string> = {},
  cookies: string[] = [flow.stateCookie],
) {
  const callback = new URL("/auth/callback", fixture.baseUrl);
  callback.searchParams.set("state", flow.state);
  callback.searchParams.set("code", "fixture-auth-code");
  for (const [name, value] of Object.entries(callbackParams)) callback.searchParams.set(name, value);
  const response = await fetch(callback, {
    redirect: "manual",
    ...(cookies.length ? { headers: { cookie: cookies.join("; ") } } : {}),
  });
  return { ...flow, response };
}

async function login(fixture: Fixture, callbackParams: Record<string, string> = {}, browserCookie?: string) {
  const flow = await beginLogin(fixture);
  const cookies = [flow.stateCookie, browserCookie].filter((cookie): cookie is string => cookie !== undefined);
  return completeLogin(fixture, flow, callbackParams, cookies);
}

function cookiePair(response: Response, name = "relay_bff"): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(header);
  return header.split(";", 1)[0]!;
}

interface GoogleConnectFlow {
  service: "gmail" | "google-calendar";
  authorizeUrl: URL;
  state: string;
  stateCookie: string;
  stateCookieHeader: string;
}

async function beginGoogleConnect(
  fixture: Fixture,
  bffCookie: string,
  service: GoogleConnectFlow["service"],
): Promise<{ response: Response; flow?: GoogleConnectFlow }> {
  const response = await fetch(`${fixture.baseUrl}/api/google/connections/${service}/connect`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: bffCookie, origin: "http://127.0.0.1:5199" },
  });
  if (response.status !== 200) return { response };
  const { authorizationUrl } = await response.json() as { authorizationUrl: string };
  const authorizeUrl = new URL(authorizationUrl);
  const cookieName = `relay_google_oauth_state_${service.replace("-", "_")}`;
  const stateCookieHeader = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${cookieName}=`));
  assert.ok(stateCookieHeader);
  const stateCookie = stateCookieHeader.split(";", 1)[0]!;
  const state = authorizeUrl.searchParams.get("state");
  assert.ok(state);
  assert.match(stateCookie.slice(cookieName.length + 1), new RegExp(`^${state}\\.[A-Za-z0-9_-]{43}$`));
  return {
    response,
    flow: {
      service,
      authorizeUrl,
      state,
      stateCookie,
      stateCookieHeader,
    },
  };
}

async function completeGoogleConnect(
  fixture: Fixture,
  flow: GoogleConnectFlow,
  bffCookie: string,
  code = "google-auth-code",
  stateCookie = flow.stateCookie,
) {
  const callback = new URL("/api/google/oauth/callback", fixture.baseUrl);
  callback.searchParams.set("state", flow.state);
  callback.searchParams.set("code", code);
  return fetch(callback, {
    redirect: "manual",
    headers: { cookie: `${bffCookie}; ${stateCookie}` },
  });
}

test("validates Supabase JWT and canonical Auth user identity", async () => {
  const goodToken = await accessToken();
  assert.deepEqual(await verifier()(goodToken), { subject: USER_ID, email: USER_EMAIL });

  const invalidSignature = await accessToken({}, { key: alternateSigningKey });
  await assert.rejects(verifier()(invalidSignature), /Invalid Supabase identity/);

  const invalidIssuer = await accessToken({}, { issuer: "https://attacker.supabase.test/auth/v1" });
  await assert.rejects(verifier()(invalidIssuer), /Invalid Supabase identity/);

  const invalidAudience = await accessToken({}, { audience: "other-service" });
  await assert.rejects(verifier()(invalidAudience), /Invalid Supabase identity/);

  const expired = await accessToken({}, { expiresAt: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(verifier()(expired), /Invalid Supabase identity/);

  // JWT user_metadata is user-editable and must not decide email verification;
  // the canonical Auth /user response below is the authority for that.
  const metadataOnlyVerification = await accessToken({ email_verified: false, user_metadata: { email_verified: true } });
  assert.deepEqual(await verifier()(metadataOnlyVerification), { subject: USER_ID, email: USER_EMAIL });

  const wrongDomain = await accessToken({ email: "teammate@example.com" });
  await assert.rejects(verifier()(wrongDomain), /Invalid Supabase identity/);

  const invalidSubject = await accessToken({ sub: "not-a-uuid" });
  await assert.rejects(verifier()(invalidSubject), /Invalid Supabase identity/);

  await assert.rejects(verifier(Date.now, { ...VERIFIED_AUTH_USER, id: OTHER_USER_ID })(goodToken), /Invalid Supabase identity/);
  await assert.rejects(verifier(Date.now, { ...VERIFIED_AUTH_USER, email: "different@houseof434.com" })(goodToken), /Invalid Supabase identity/);
  const unconfirmedAuthUser = { id: USER_ID, email: USER_EMAIL, user_metadata: { email_verified: true } };
  await assert.rejects(verifier(Date.now, unconfirmedAuthUser)(goodToken), /Invalid Supabase identity/);
  assert.deepEqual(
    await verifier(Date.now, { id: USER_ID, email: USER_EMAIL, confirmed_at: "2026-01-01T00:00:00.000Z" })(goodToken),
    { subject: USER_ID, email: USER_EMAIL },
  );
});

test("requires BFF capability and Supabase configuration instead of starting a direct-harness fallback", () => {
  assert.throws(() => configFromEnvironment({}), /SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, RELAY_BFF_CAPABILITY/);
  const defaultConfig = configFromEnvironment({
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_ANON_KEY,
    RELAY_BFF_CAPABILITY: BFF_CAPABILITY,
  });
  const { googleOAuthClients, googleRedirectUri, googleTokenEncryptionKey, relayToolActorSecret, dataDir, ...baseConfig } = defaultConfig;
  assert.deepEqual(baseConfig, CONFIG);
  assert.equal(relayToolActorSecret, undefined);
  assert.equal(configFromEnvironment({
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_ANON_KEY,
    RELAY_BFF_CAPABILITY: BFF_CAPABILITY,
    RELAY_TOOL_ACTOR_SECRET: "actor-secret-fixture-value-000000000000000000",
  }).relayToolActorSecret, "actor-secret-fixture-value-000000000000000000");
  assert.deepEqual(googleOAuthClients, {
    gmail: { clientId: undefined, clientSecret: undefined },
    "google-calendar": { clientId: undefined, clientSecret: undefined },
  });
  assert.equal(googleRedirectUri, undefined);
  assert.equal(googleTokenEncryptionKey, undefined);
  assert.ok(dataDir?.endsWith(".relay"));
  const independentClients = configFromEnvironment({
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_ANON_KEY,
    RELAY_BFF_CAPABILITY: BFF_CAPABILITY,
    RELAY_CONN_GMAIL_CLIENT_ID: "gmail-client-id",
    RELAY_CONN_GMAIL_CLIENT_SECRET: "gmail-client-secret",
    RELAY_CONN_CALENDAR_CLIENT_ID: "calendar-client-id",
    RELAY_CONN_CALENDAR_CLIENT_SECRET: "calendar-client-secret",
    RELAY_GOOGLE_REDIRECT_URI: "http://localhost:8798/api/google/oauth/callback",
    RELAY_TOKEN_ENCRYPTION_KEY: GOOGLE_TOKEN_KEY,
    RELAY_DATA_DIR: "/tmp/relay-bff-data",
  });
  assert.equal(independentClients.googleOAuthClients?.gmail?.clientId, "gmail-client-id");
  assert.equal(independentClients.googleOAuthClients?.gmail?.clientSecret, "gmail-client-secret");
  assert.equal(independentClients.googleOAuthClients?.["google-calendar"]?.clientId, "calendar-client-id");
  assert.equal(independentClients.googleOAuthClients?.["google-calendar"]?.clientSecret, "calendar-client-secret");
  assert.equal(independentClients.dataDir, "/tmp/relay-bff-data");
  assert.equal(configFromEnvironment({
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_ANON_KEY,
    RELAY_BFF_CAPABILITY: BFF_CAPABILITY,
    RELAY_BFF_PORT: "8888",
  }).relayBffPublicUrl, "http://localhost:8888");
  assert.equal(configFromEnvironment({
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_ANON_KEY,
    RELAY_BFF_CAPABILITY: BFF_CAPABILITY,
    RELAY_BFF_PUBLIC_URL: "https://chat.example.test/",
  }).relayBffPublicUrl, "https://chat.example.test");
  assert.throws(() => createRelayBff({ config: { ...CONFIG, relayBffCapability: "short" } }), /RELAY_BFF_CAPABILITY/);
});

test("advertises the hosted sign-in provider without exposing configuration", async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/auth/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true, provider: "google", domain: "houseof434.com" });
  assert.equal(fixture.requests.length, 0);
});

test("starts Supabase Google PKCE, exchanges a single-use state, and issues only a client Relay session", async () => {
  const fixture = await startFixture();
  const result = await login(fixture, {
    userId: "browser-supplied-user",
    email: "attacker@example.com",
    scopes: "admin",
  });

  assert.equal(result.authorizeUrl.origin, PROJECT_URL);
  assert.equal(result.authorizeUrl.pathname, "/auth/v1/authorize");
  assert.equal(result.authorizeUrl.searchParams.get("provider"), "google");
  assert.equal(result.authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const challenge = result.authorizeUrl.searchParams.get("code_challenge");
  assert.match(challenge ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.callbackUrl.origin, "http://localhost:8798");
  assert.equal(result.callbackUrl.pathname, "/auth/callback");
  assert.match(result.stateCookie, new RegExp(`^relay_bff_oauth_state=${result.state}$`));
  assert.match(result.stateCookieHeader, /HttpOnly/);
  assert.match(result.stateCookieHeader, /SameSite=Lax/);
  assert.match(result.stateCookieHeader, /Path=\/auth\/callback/);
  assert.match(result.stateCookieHeader, /Max-Age=600/);
  assert.doesNotMatch(result.stateCookieHeader, /Secure/);

  assert.equal(result.response.status, 303);
  assert.equal(result.response.headers.get("location"), "http://localhost:5199/");
  const cookies = result.response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  const cookie = cookies.find((value) => value.startsWith("relay_bff="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookiePair(result.response, "relay_bff_oauth_state"), /^relay_bff_oauth_state=$/);
  assert.match(cookies.find((value) => value.startsWith("relay_bff_oauth_state=")) ?? "", /Max-Age=0/);
  assert.doesNotMatch(cookie, new RegExp(ACCESS_TOKEN_SENTINEL));
  assert.doesNotMatch(cookie, new RegExp(RELAY_TOKEN));
  assert.equal(await result.response.text(), "");

  const exchange = fixture.requests.find((request) => request.url.pathname === "/auth/v1/token")!;
  const exchangeBody = JSON.parse(exchange.body) as { grant_type: string; auth_code: string; code_verifier: string };
  assert.equal(exchangeBody.grant_type, "pkce");
  assert.equal(exchangeBody.auth_code, "fixture-auth-code");
  assert.equal(createHash("sha256").update(exchangeBody.code_verifier).digest("base64url"), challenge);
  assert.equal(exchange.headers.get("apikey"), SUPABASE_ANON_KEY);

  const userLookup = fixture.requests.find((request) => request.url.pathname === "/auth/v1/user")!;
  assert.equal(userLookup.init.method, "GET");
  assert.equal(userLookup.headers.get("apikey"), SUPABASE_ANON_KEY);
  assert.match(userLookup.headers.get("authorization") ?? "", /^Bearer \S+$/);
  assert.equal(userLookup.body, "");

  const bridge = fixture.requests.find((request) => request.url.pathname === "/api/internal/portal-session")!;
  assert.equal(bridge.init.method, "POST");
  assert.equal(bridge.headers.get("authorization"), `Bearer ${BFF_CAPABILITY}`);
  assert.deepEqual(JSON.parse(bridge.body), { userId: USER_ID, email: USER_EMAIL, scopes: ["client"] });
  assert.equal(bridge.headers.has("apikey"), false);
  assert.equal(bridge.body.includes(ACCESS_TOKEN_SENTINEL), false);
  assert.equal(bridge.body.includes(SUPABASE_ANON_KEY), false);
  assert.equal(bridge.body.includes(RELAY_TOKEN), false);

  const replay = await fetch(`${fixture.baseUrl}/auth/callback?state=${encodeURIComponent(result.state)}&code=second-code`, {
    redirect: "manual",
    headers: { cookie: result.stateCookie },
  });
  assert.equal(replay.status, 400);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/auth/v1/token").length, 1);
  assert.doesNotMatch(await replay.text(), /second-code|fixture-auth-code|supabase/);
});

test("requires a matching browser state cookie and then accepts the legitimate callback", async () => {
  const fixture = await startFixture();
  const flow = await beginLogin(fixture);
  const wrongCookie = await completeLogin(fixture, flow, {}, [`relay_bff_oauth_state=${"x".repeat(43)}`]);
  assert.equal(wrongCookie.response.status, 400);
  const missingCookie = await completeLogin(fixture, flow, {}, []);
  assert.equal(missingCookie.response.status, 400);
  assert.match(missingCookie.response.headers.getSetCookie().find((cookie) => cookie.startsWith("relay_bff_oauth_state=")) ?? "", /Max-Age=0/);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/auth/v1/token").length, 0);

  const legitimate = await completeLogin(fixture, flow);
  assert.equal(legitimate.response.status, 303);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/auth/v1/token").length, 1);
});

test("requires verified, matching canonical Supabase Auth profile before issuing a Relay session", async () => {
  const cases: Array<{ claims?: Record<string, unknown>; authUser: unknown }> = [
    { authUser: { ...VERIFIED_AUTH_USER, id: OTHER_USER_ID } },
    { authUser: { ...VERIFIED_AUTH_USER, email: "different@houseof434.com" } },
    { authUser: { id: USER_ID, email: USER_EMAIL, user_metadata: { email_verified: true } } },
  ];
  for (const testCase of cases) {
    const fixture = await startFixture(testCase);
    const result = await login(fixture);
    assert.equal(result.response.status, 401);
    assert.equal(fixture.requests.some((request) => request.url.pathname === "/api/internal/portal-session"), false);
  }
});

test("uses the configured HTTPS callback origin and Secure cookies", async () => {
  const fixture = await startFixture({ config: { relayBffPublicUrl: "https://chat.example.test" } });
  const flow = await beginLogin(fixture);
  assert.equal(flow.callbackUrl.origin, "https://chat.example.test");
  assert.match(flow.stateCookieHeader, /; Secure(?:;|$)/);

  const result = await completeLogin(fixture, flow);
  assert.equal(result.response.status, 303);
  assert.equal(result.response.headers.get("location"), "https://chat.example.test/");
  assert.match(result.response.headers.getSetCookie().find((cookie) => cookie.startsWith("relay_bff=")) ?? "", /; Secure(?:;|$)/);
  assert.match(result.response.headers.getSetCookie().find((cookie) => cookie.startsWith("relay_bff_oauth_state=")) ?? "", /; Secure(?:;|$)/);

  const proxied = await fetch(`${fixture.baseUrl}/api/bots`, {
    headers: { cookie: cookiePair(result.response), origin: "https://chat.example.test" },
  });
  assert.equal(proxied.status, 200);
});

test("revokes the previous Relay session before replacing its BFF cookie", async () => {
  const fixture = await startFixture();
  const firstLogin = await login(fixture);
  const previousCookie = cookiePair(firstLogin.response);
  const secondLogin = await login(fixture, {}, previousCookie);
  assert.equal(secondLogin.response.status, 303);

  const revokeIndex = fixture.requests.findIndex((request) => request.url.pathname === "/api/internal/portal-session/revoke");
  const issueIndexes = fixture.requests
    .map((request, index) => request.url.pathname === "/api/internal/portal-session" ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(issueIndexes.length, 2);
  assert.ok(revokeIndex > issueIndexes[1]!);
  const revoke = fixture.requests[revokeIndex]!;
  assert.equal(revoke.init.method, "POST");
  assert.equal(revoke.headers.get("authorization"), `Bearer ${BFF_CAPABILITY}`);
  assert.deepEqual(JSON.parse(revoke.body), { sessionId: RELAY_SESSION_ID });
  assert.equal(revoke.body.includes(RELAY_TOKEN), false);
  assert.equal(revoke.headers.has("apikey"), false);

  const oldSession = await fetch(`${fixture.baseUrl}/api/bots`, { headers: { cookie: previousCookie } });
  assert.equal(oldSession.status, 401);
  const currentSession = await fetch(`${fixture.baseUrl}/api/bots`, {
    headers: { cookie: cookiePair(secondLogin.response) },
  });
  assert.equal(currentSession.status, 200);
});

test("rejects an unknown OAuth state without exchanging its code", async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/auth/callback?state=${"x".repeat(43)}&code=auth-code-secret`, { redirect: "manual" });
  assert.equal(response.status, 400);
  assert.equal(fixture.requests.length, 0);
  assert.doesNotMatch(await response.text(), /auth-code-secret/);
});

test("requires the BFF cookie and strips browser credentials before proxying application APIs", async () => {
  const fixture = await startFixture();
  const unsigned = await fetch(`${fixture.baseUrl}/api/bots`, {
    headers: { authorization: `Bearer ${ACCESS_TOKEN_SENTINEL}` },
  });
  assert.equal(unsigned.status, 401);
  assert.equal(fixture.requests.length, 0);

  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const response = await fetch(`${fixture.baseUrl}/api/bots?limit=3`, {
    headers: {
      cookie: `${cookie}; sb-access-token=${ACCESS_TOKEN_SENTINEL}`,
      authorization: `Bearer ${ACCESS_TOKEN_SENTINEL}`,
      apikey: SUPABASE_ANON_KEY,
      "x-api-key": SUPABASE_ANON_KEY,
      "x-supabase-access-token": ACCESS_TOKEN_SENTINEL,
      origin: "http://127.0.0.1:5199",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "upstream response");
  assert.equal(response.headers.get("set-cookie"), null);

  const proxied = fixture.requests.find((request) => request.url.pathname === "/api/bots")!;
  assert.equal(proxied.url.search, "?limit=3");
  assert.equal(proxied.headers.get("authorization"), `Bearer ${RELAY_TOKEN}`);
  assert.equal(proxied.headers.has("cookie"), false);
  assert.equal(proxied.headers.has("apikey"), false);
  assert.equal(proxied.headers.has("x-api-key"), false);
  assert.equal(proxied.headers.has("x-supabase-access-token"), false);
  assert.notEqual(proxied.headers.get("authorization"), `Bearer ${ACCESS_TOKEN_SENTINEL}`);
  assert.equal(proxied.headers.get("origin"), "http://127.0.0.1:8799");

  const callsBeforeForbiddenOrigin = fixture.requests.filter((request) => request.url.pathname === "/api/bots").length;
  const forbiddenOrigin = await fetch(`${fixture.baseUrl}/api/bots`, {
    headers: { cookie, origin: "http://attacker.example:5199" },
  });
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/api/bots").length, callsBeforeForbiddenOrigin);
});

test("never proxies browser access to internal harness routes", async () => {
  const fixture = await startFixture();
  const signedIn = await login(fixture);
  const issuedBridgeCalls = fixture.requests.filter((request) => request.url.pathname.startsWith("/api/internal/")).length;
  const response = await fetch(`${fixture.baseUrl}/api/internal/portal-session`, {
    headers: { cookie: cookiePair(signedIn.response) },
  });
  assert.equal(response.status, 404);
  assert.equal(fixture.requests.filter((request) => request.url.pathname.startsWith("/api/internal/")).length, issuedBridgeCalls);
});

test("proxies public environment discovery without browser Supabase credentials", async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/.well-known/relay/environment`, {
    headers: {
      cookie: `sb-access-token=${ACCESS_TOKEN_SENTINEL}`,
      authorization: `Bearer ${ACCESS_TOKEN_SENTINEL}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  assert.equal(response.status, 200);
  const proxied = fixture.requests.find((request) => request.url.pathname === "/.well-known/relay/environment")!;
  assert.equal(proxied.headers.has("cookie"), false);
  assert.equal(proxied.headers.has("authorization"), false);
  assert.equal(proxied.headers.has("apikey"), false);
});

test("logout revokes the Relay token at the harness and clears the BFF cookie", async () => {
  const fixture = await startFixture();
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const response = await fetch(`${fixture.baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      cookie: `${cookie}; sb-refresh-token=supabase-refresh-token-must-stay-on-bff`,
      authorization: `Bearer ${ACCESS_TOKEN_SENTINEL}`,
      origin: "http://127.0.0.1:5199",
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie") ?? "", /relay_bff=;.*Max-Age=0/);

  const logout = fixture.requests.find((request) => request.url.pathname === "/api/auth/logout")!;
  assert.equal(logout.init.method, "POST");
  assert.equal(logout.headers.get("authorization"), `Bearer ${RELAY_TOKEN}`);
  assert.equal(logout.headers.has("cookie"), false);
  assert.equal(logout.body, "{}");

  const afterLogout = await fetch(`${fixture.baseUrl}/api/bots`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/api/bots").length, 0);
});

test("preserves the streamed harness event response", async () => {
  const fixture = await startFixture();
  const signedIn = await login(fixture);
  const response = await fetch(`${fixture.baseUrl}/api/events`, {
    headers: { cookie: cookiePair(signedIn.response) },
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
});

test("expires the in-memory BFF session", async () => {
  let now = Date.now();
  const fixture = await startFixture({ now: () => now, sessionTtlMs: 1000 });
  const signedIn = await login(fixture);
  now += 1001;
  const response = await fetch(`${fixture.baseUrl}/api/bots`, {
    headers: { cookie: cookiePair(signedIn.response) },
  });
  assert.equal(response.status, 401);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/api/bots").length, 0);
});

test("does not reveal full Supabase provider errors or authorization codes", async () => {
  const providerSecret = "provider-error-secret-code-value";
  const requests: CapturedRequest[] = [];
  const failingFetcher: typeof fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    requests.push({ url, init, headers: new Headers(init.headers), body: await bodyString(init.body) });
    if (url.pathname === "/auth/v1/token") return Response.json({ error_description: providerSecret }, { status: 400 });
    throw new Error("Unexpected fixture URL");
  };
  const fixture = await startFixture({ fetcher: failingFetcher });
  const start = await fetch(`${fixture.baseUrl}/auth/login`, { redirect: "manual" });
  const stateCookie = start.headers.getSetCookie().find((cookie) => cookie.startsWith("relay_bff_oauth_state="))!.split(";", 1)[0]!;
  const callback = new URL("/auth/callback", fixture.baseUrl);
  callback.searchParams.set("state", stateCookie.slice("relay_bff_oauth_state=".length));
  callback.searchParams.set("code", providerSecret);
  const response = await fetch(callback, { redirect: "manual", headers: { cookie: stateCookie } });
  assert.equal(response.status, 401);
  const responseBody = await response.text();
  assert.doesNotMatch(responseBody, new RegExp(providerSecret));
  assert.doesNotMatch(responseBody, /error_description/);
});

test("keeps Gmail and Calendar clients and baseline scopes independent", async () => {
  assert.equal(GOOGLE_SERVICE_REGISTRY.gmail.clientIdEnvironmentVariable, "RELAY_CONN_GMAIL_CLIENT_ID");
  assert.equal(GOOGLE_SERVICE_REGISTRY.gmail.clientSecretEnvironmentVariable, "RELAY_CONN_GMAIL_CLIENT_SECRET");
  assert.equal(GOOGLE_SERVICE_REGISTRY["google-calendar"].clientIdEnvironmentVariable, "RELAY_CONN_CALENDAR_CLIENT_ID");
  assert.equal(GOOGLE_SERVICE_REGISTRY["google-calendar"].clientSecretEnvironmentVariable, "RELAY_CONN_CALENDAR_CLIENT_SECRET");
  assert.deepEqual(GOOGLE_SERVICE_SCOPES.gmail, [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
  assert.deepEqual(GOOGLE_SERVICE_SCOPES["google-calendar"], [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]);
  assert.equal(GOOGLE_SERVICE_SCOPES.gmail.some((scope) => scope.endsWith("gmail.send")), false);

  const dataDir = await temporaryDataDir();
  const fixture = await startFixture({
    dataDir,
    config: {
      ...GOOGLE_CONFIG,
      googleOAuthClients: { gmail: { clientId: "gmail-only-id", clientSecret: "gmail-only-secret" } },
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const status = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
  assert.deepEqual(await status.json(), {
    accounts: [],
    configured: true,
    services: { gmail: true, "google-calendar": false },
  });

  const gmail = await beginGoogleConnect(fixture, cookie, "gmail");
  assert.equal(gmail.response.status, 200);
  assert.equal(gmail.flow?.authorizeUrl.searchParams.get("client_id"), "gmail-only-id");
  assert.equal(gmail.flow?.authorizeUrl.searchParams.get("scope"), GOOGLE_SERVICE_SCOPES.gmail.join(" "));
  assert.equal(gmail.flow?.authorizeUrl.searchParams.get("redirect_uri"), GOOGLE_CONFIG.googleRedirectUri);

  const calendar = await beginGoogleConnect(fixture, cookie, "google-calendar");
  assert.equal(calendar.response.status, 503);
  assert.equal(calendar.response.headers.get("location"), null);
});

test("Google connect requires a same-origin POST, not a cross-site navigation", async () => {
  const fixture = await startFixture({ dataDir: await temporaryDataDir(), config: GOOGLE_CONFIG });
  const signedIn = await login(fixture);
  const response = await fetch(`${fixture.baseUrl}/api/google/connections/gmail/connect`, {
    method: "POST",
    headers: { cookie: cookiePair(signedIn.response) },
  });
  assert.equal(response.status, 403);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/token").length, 0);
});

test("uses browser-bound per-service state, the authenticated session, PKCE, and the matching OAuth client", async () => {
  const dataDir = await temporaryDataDir();
  const fixture = await startFixture({ dataDir, config: GOOGLE_CONFIG });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const gmail = await beginGoogleConnect(fixture, cookie, "gmail");
  const calendar = await beginGoogleConnect(fixture, cookie, "google-calendar");
  assert.equal(gmail.response.status, 200);
  assert.equal(calendar.response.status, 200);
  assert.ok(gmail.flow && calendar.flow);
  assert.notEqual(gmail.flow.state, calendar.flow.state);
  assert.notEqual(gmail.flow.stateCookie.split("=", 1)[0], calendar.flow.stateCookie.split("=", 1)[0]);
  assert.match(gmail.flow.stateCookieHeader, /HttpOnly/);
  assert.match(gmail.flow.stateCookieHeader, /SameSite=Lax/);
  assert.match(gmail.flow.stateCookieHeader, /Path=\/api\/google\/oauth\/callback/);
  assert.match(gmail.flow.stateCookieHeader, /Max-Age=600/);

  const authorizeUrl = gmail.flow.authorizeUrl;
  assert.equal(authorizeUrl.origin, "https://accounts.google.com");
  assert.equal(authorizeUrl.pathname, "/o/oauth2/v2/auth");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "gmail-client-id");
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizeUrl.searchParams.get("include_granted_scopes"), "true");
  assert.equal(authorizeUrl.searchParams.get("prompt"), "consent select_account");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const challenge = authorizeUrl.searchParams.get("code_challenge");
  assert.match(challenge ?? "", /^[A-Za-z0-9_-]{43}$/);

  const wrongServiceCookie = await completeGoogleConnect(fixture, gmail.flow, cookie, "wrong-cookie-code", calendar.flow.stateCookie);
  assert.equal(wrongServiceCookie.status, 400);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/token").length, 0);

  const callback = await completeGoogleConnect(fixture, gmail.flow, cookie, "valid-gmail-code");
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "http://localhost:5199/?connections=connected");
  const replay = await completeGoogleConnect(fixture, gmail.flow, cookie, "replay-code");
  assert.equal(replay.status, 400);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/token").length, 1);
  const exchange = fixture.requests.find((request) => request.url.pathname === "/token")!;
  const exchangeBody = new URLSearchParams(exchange.body);
  assert.equal(exchangeBody.get("client_id"), "gmail-client-id");
  assert.equal(exchangeBody.get("client_secret"), "gmail-client-secret");
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(exchangeBody.get("redirect_uri"), GOOGLE_CONFIG.googleRedirectUri);
  assert.equal(createHash("sha256").update(exchangeBody.get("code_verifier")!).digest("base64url"), challenge);
  const userinfo = fixture.requests.find((request) => request.url.pathname === "/v1/userinfo")!;
  assert.equal(userinfo.init.method, "GET");
  assert.equal(userinfo.headers.get("authorization"), "Bearer google-access-token-must-not-leave-bff");

  const listing = await fetch(`${fixture.baseUrl}/api/google/connections?userId=${OTHER_USER_ID}`, { headers: { cookie } });
  const responseText = await listing.text();
  assert.doesNotMatch(responseText, /google-access-token-must-not-leave-bff|google-refresh-token-must-not-leave-bff|gmail-client-secret/);
  const connections = JSON.parse(responseText) as { accounts: Array<{ service: string; id: string; email: string }> };
  assert.equal(connections.accounts.length, 1);
  assert.equal(connections.accounts[0]?.service, "gmail");
  assert.equal(connections.accounts[0]?.email, "google-user@example.com");
  assert.match(connections.accounts[0]?.id ?? "", /^[A-Za-z0-9_-]{43}$/);

  const storeFile = await readFile(join(dataDir, "google-connections.json"), "utf8");
  assert.doesNotMatch(storeFile, /google-access-token-must-not-leave-bff|google-refresh-token-must-not-leave-bff/);
  assert.equal((await stat(join(dataDir, "google-connections.json"))).mode & 0o777, 0o600);
});

test("does not return Google upstream errors, authorization codes, or credentials", async () => {
  const providerDetail = "google-provider-error-detail-secret";
  const authorizationCode = "google-authorization-code-secret";
  const fixture = await startFixture({
    dataDir: await temporaryDataDir(),
    config: GOOGLE_CONFIG,
    google: {
      tokenExchangeStatus: 400,
      defaultExchange: { error: "invalid_grant", error_description: providerDetail },
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const flow = await beginGoogleConnect(fixture, cookie, "gmail");
  assert.ok(flow.flow);
  const response = await completeGoogleConnect(fixture, flow.flow, cookie, authorizationCode);
  assert.equal(response.status, 401);
  const responseText = await response.text();
  assert.doesNotMatch(responseText, new RegExp(providerDetail));
  assert.doesNotMatch(responseText, new RegExp(authorizationCode));
  assert.doesNotMatch(responseText, /gmail-client-secret|google-access-token|google-refresh-token|error_description/);
});

test("rejects a Google callback after its initiating BFF session is replaced", async () => {
  const fixture = await startFixture({ dataDir: await temporaryDataDir(), config: GOOGLE_CONFIG });
  const original = await login(fixture);
  const originalCookie = cookiePair(original.response);
  const connect = await beginGoogleConnect(fixture, originalCookie, "gmail");
  assert.ok(connect.flow);

  const replacement = await login(fixture, {}, originalCookie);
  const response = await completeGoogleConnect(fixture, connect.flow, cookiePair(replacement.response));
  assert.equal(response.status, 401);
  assert.match(await response.text(), /session changed/);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/token").length, 0);
});

test("binds Google OAuth state to the initiating Relay actor", async () => {
  const otherIdentity = {
    id: OTHER_USER_ID,
    email: "other@houseof434.com",
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
  };
  const fixture = await startFixture({
    dataDir: await temporaryDataDir(),
    config: GOOGLE_CONFIG,
    alternateLogins: [{
      code: "other-user-login-code",
      claims: { sub: OTHER_USER_ID, email: otherIdentity.email },
      authUser: otherIdentity,
    }],
  });
  const owner = await login(fixture);
  const ownerCookie = cookiePair(owner.response);
  const flow = await beginGoogleConnect(fixture, ownerCookie, "gmail");
  assert.ok(flow.flow);

  const otherActor = await login(fixture, { code: "other-user-login-code" });
  const rejected = await completeGoogleConnect(fixture, flow.flow, cookiePair(otherActor.response));
  assert.equal(rejected.status, 401);
  assert.match(await rejected.text(), /session changed/);
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/token").length, 0);
});

test("requires verified Google userinfo and stores its immutable subject and email", async () => {
  const dataDir = await temporaryDataDir();
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    google: {
      defaultUserinfo: { sub: "immutable-google-subject", email: "verified@example.com", email_verified: true },
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const flow = await beginGoogleConnect(fixture, cookie, "google-calendar");
  assert.ok(flow.flow);
  const callback = await completeGoogleConnect(fixture, flow.flow, cookie);
  assert.equal(callback.status, 303);
  const exchangeBody = new URLSearchParams(fixtureRequestsAt(fixture, "/token")[0]!.body);
  assert.equal(exchangeBody.get("client_id"), "calendar-client-id");
  assert.equal(exchangeBody.get("client_secret"), "calendar-client-secret");

  const listing = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
  const body = await listing.json() as { accounts: Array<{ service: string; id: string; email: string }> };
  assert.deepEqual(body.accounts.map(({ service, email }) => ({ service, email })), [
    { service: "google-calendar", email: "verified@example.com" },
  ]);

  const unverifiedDataDir = await temporaryDataDir();
  const unverified = await startFixture({
    dataDir: unverifiedDataDir,
    config: GOOGLE_CONFIG,
    google: { defaultUserinfo: { sub: "unverified-subject", email: "unverified@example.com", email_verified: false } },
  });
  const unverifiedLogin = await login(unverified);
  const unverifiedCookie = cookiePair(unverifiedLogin.response);
  const unverifiedFlow = await beginGoogleConnect(unverified, unverifiedCookie, "gmail");
  assert.ok(unverifiedFlow.flow);
  const rejected = await completeGoogleConnect(unverified, unverifiedFlow.flow, unverifiedCookie);
  assert.equal(rejected.status, 401);
  assert.match(await rejected.text(), /email could not be verified/);
  const empty = await fetch(`${unverified.baseUrl}/api/google/connections`, { headers: { cookie: unverifiedCookie } });
  assert.deepEqual((await empty.json() as { accounts: unknown[] }).accounts, []);
});

test("stores normalized scopes granted in the Google OAuth token response", async () => {
  const dataDir = await temporaryDataDir();
  const grantedScopes = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
  ];
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    google: {
      exchanges: {
        granted: {
          access_token: "scope-response-access-fixture",
          refresh_token: "scope-response-refresh-fixture",
          scope: grantedScopes.join(" "),
        },
      },
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const flow = await beginGoogleConnect(fixture, cookie, "gmail");
  assert.ok(flow.flow);
  assert.equal((await completeGoogleConnect(fixture, flow.flow, cookie, "granted")).status, 303);

  const store = new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY });
  const [account] = await store.list(USER_ID);
  assert.ok(account);
  const credential = await store.internalCredentialForAccount(USER_ID, "gmail", account.id);
  assert.deepEqual(credential?.scopes, [...new Set(grantedScopes)].sort());
});

test("preserves a stored refresh token when Google omits it and rejects a new account without one", async () => {
  const dataDir = await temporaryDataDir();
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    google: {
      exchanges: {
        first: { access_token: "access-first", refresh_token: "preserved-refresh-token" },
        reconnect: { access_token: "access-reconnect" },
        newAccount: { access_token: "access-new-account" },
      },
      userinfoByAccessToken: {
        "access-first": { sub: "same-google-sub", email: "same@example.com", email_verified: true },
        "access-reconnect": { sub: "same-google-sub", email: "same@example.com", email_verified: true },
        "access-new-account": { sub: "new-google-sub", email: "new@example.com", email_verified: true },
      },
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);

  for (const code of ["first", "reconnect"]) {
    const flow = await beginGoogleConnect(fixture, cookie, "gmail");
    assert.ok(flow.flow);
    const callback = await completeGoogleConnect(fixture, flow.flow, cookie, code);
    assert.equal(callback.status, 303);
  }
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY });
  const [account] = await store.list(USER_ID);
  assert.ok(account);
  assert.equal(await store.refreshTokenForAccount(USER_ID, "gmail", account.id), "preserved-refresh-token");

  const newAccountFlow = await beginGoogleConnect(fixture, cookie, "gmail");
  assert.ok(newAccountFlow.flow);
  const missing = await completeGoogleConnect(fixture, newAccountFlow.flow, cookie, "newAccount");
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /did not return a refresh token/);
  assert.equal((await store.list(USER_ID)).length, 1);
});

test("lists multiple accounts per service only to their Relay owner and denies cross-user deletion", async () => {
  const dataDir = await temporaryDataDir();
  const ownerFixture = await startFixture({ dataDir, config: GOOGLE_CONFIG, google: {
    exchanges: {
      first: { access_token: "owner-account-one", refresh_token: "owner-refresh-one" },
      second: { access_token: "owner-account-two", refresh_token: "owner-refresh-two" },
    },
    userinfoByAccessToken: {
      "owner-account-one": { sub: "owner-sub-one", email: "one@example.com", email_verified: true },
      "owner-account-two": { sub: "owner-sub-two", email: "two@example.com", email_verified: true },
    },
  } });
  const ownerLogin = await login(ownerFixture);
  const ownerCookie = cookiePair(ownerLogin.response);
  for (const code of ["first", "second"]) {
    const flow = await beginGoogleConnect(ownerFixture, ownerCookie, "gmail");
    assert.ok(flow.flow);
    assert.equal((await completeGoogleConnect(ownerFixture, flow.flow, ownerCookie, code)).status, 303);
  }
  const ownerList = await fetch(`${ownerFixture.baseUrl}/api/google/connections`, { headers: { cookie: ownerCookie } });
  const ownerAccounts = (await ownerList.json() as { accounts: Array<{ id: string }> }).accounts;
  assert.equal(ownerAccounts.length, 2);

  const otherFixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    claims: { sub: OTHER_USER_ID, email: "other@houseof434.com" },
    authUser: { id: OTHER_USER_ID, email: "other@houseof434.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" },
  });
  const otherLogin = await login(otherFixture);
  const otherCookie = cookiePair(otherLogin.response);
  const otherList = await fetch(`${otherFixture.baseUrl}/api/google/connections?userId=${USER_ID}`, {
    headers: { cookie: otherCookie },
  });
  assert.deepEqual((await otherList.json() as { accounts: unknown[] }).accounts, []);
  const deniedDelete = await fetch(`${otherFixture.baseUrl}/api/google/connections/gmail/${ownerAccounts[0]!.id}`, {
    method: "DELETE",
    headers: { cookie: otherCookie, origin: "http://127.0.0.1:5199" },
  });
  assert.equal(deniedDelete.status, 404);
  assert.equal(fixtureRequestsAt(ownerFixture, "/revoke").length, 0);
  const ownerListAfter = await fetch(`${ownerFixture.baseUrl}/api/google/connections`, { headers: { cookie: ownerCookie } });
  assert.equal((await ownerListAfter.json() as { accounts: unknown[] }).accounts.length, 2);
});

test("Google Calendar events are actor-isolated, paginated, sanitized, and read-only", async () => {
  const dataDir = await temporaryDataDir();
  const calls: CalendarListCall[] = [];
  const scopes: string[][] = [];
  const writes: string[] = [];
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY });
  const ownerOne = await store.save({
    userId: USER_ID,
    service: "google-calendar",
    googleSub: "calendar-owner-one-subject",
    email: "one-calendar@example.com",
    refreshToken: "owner-one-calendar-refresh-fixture",
  });
  const ownerTwo = await store.save({
    userId: USER_ID,
    service: "google-calendar",
    googleSub: "calendar-owner-two-subject",
    email: "two-calendar@example.com",
    refreshToken: "owner-two-calendar-refresh-fixture",
  });
  const otherAccount = await store.save({
    userId: OTHER_USER_ID,
    service: "google-calendar",
    googleSub: "calendar-other-user-subject",
    email: "other-calendar@example.com",
    refreshToken: "other-calendar-refresh-fixture",
  });
  const googleApi = calendarGateway(async ({ accountId, params }) => {
    if (accountId === ownerOne.id && params.pageToken === undefined) {
      return { data: {
        items: [
          {
            id: "cancelled-event",
            summary: "Cancelled meeting",
            description: "Cancelled event notes",
            status: "cancelled",
            htmlLink: "https://calendar.google.com/calendar/event?eid=cancelled-event",
            start: { dateTime: "2026-01-03T10:00:00-05:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-01-03T10:30:00-05:00", timeZone: "America/New_York" },
            creator: { email: "private-creator@example.com" },
          },
          {
            id: "all-day-event",
            summary: "Company holiday",
            status: "confirmed",
            start: { date: "2026-01-04", timeZone: "Pacific/Tahiti" },
            end: { date: "2026-01-05", timeZone: "Pacific/Tahiti" },
            private: { secret: "not-for-ui" },
          },
        ],
        nextPageToken: "owner-one-next-page",
      } };
    }
    if (accountId === ownerOne.id && params.pageToken === "owner-one-next-page") {
      return { data: { items: [{
        id: "timed-event",
        summary: "Planning session",
        start: { dateTime: "2026-01-05T09:00:00Z" },
        end: { dateTime: "2026-01-05T10:00:00Z" },
      }] } };
    }
    if (accountId === ownerTwo.id) {
      return { data: { items: [{
        id: "second-account-event",
        summary: "Second calendar event",
        start: { dateTime: "2026-01-06T09:00:00Z" },
        end: { dateTime: "2026-01-06T09:30:00Z" },
      }] } };
    }
    if (accountId === otherAccount.id) {
      return { data: { items: [{
        id: "other-user-event",
        summary: "Private to user B",
        start: { dateTime: "2026-01-06T09:00:00Z" },
        end: { dateTime: "2026-01-06T09:30:00Z" },
      }] } };
    }
    throw new Error("Unexpected Google account");
  }, calls, scopes, writes);
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    googleApi,
    alternateLogins: [{
      code: "other-calendar-user-login",
      claims: { sub: OTHER_USER_ID, email: "other@houseof434.com" },
      authUser: { id: OTHER_USER_ID, email: "other@houseof434.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" },
    }],
  });
  const owner = await login(fixture);
  const ownerCookie = cookiePair(owner.response);
  const other = await login(fixture, { code: "other-calendar-user-login" });
  const otherCookie = cookiePair(other.response);
  assert.notEqual(otherCookie, ownerCookie);
  assert.equal(other.response.status, 303);
  const otherConnections = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie: otherCookie } });
  assert.deepEqual((await otherConnections.json() as { accounts: Array<{ id: string }> }).accounts.map(({ id }) => id), [otherAccount.id]);
  const query = "timeMin=2026-01-01T00%3A00%3A00Z&timeMax=2026-01-08T00%3A00%3A00Z";

  const ownerResponse = await fetch(`${fixture.baseUrl}/api/google/calendar/events?${query}&userId=${OTHER_USER_ID}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(ownerResponse.status, 200);
  const ownerText = await ownerResponse.text();
  const ownerBody = JSON.parse(ownerText) as {
    configured: boolean;
    connected: boolean;
    events: Array<Record<string, unknown> & { accountId: string; eventId: string; status: string; allDay: boolean; start: Record<string, string> }>;
    errors: unknown[];
  };
  assert.equal(ownerBody.configured, true);
  assert.equal(ownerBody.connected, true);
  assert.deepEqual(ownerBody.errors, []);
  assert.deepEqual([...new Set(ownerBody.events.map((event) => event.accountId))].sort(), [ownerOne.id, ownerTwo.id].sort());
  assert.equal(ownerBody.events.some((event) => event.eventId === "other-user-event"), false);
  assert.equal(ownerBody.events.find((event) => event.eventId === "cancelled-event")?.status, "cancelled");
  const allDay = ownerBody.events.find((event) => event.eventId === "all-day-event");
  assert.equal(allDay?.allDay, true);
  assert.deepEqual(allDay?.start, { date: "2026-01-04" });
  assert.equal(ownerBody.events.find((event) => event.eventId === "timed-event")?.eventId, "timed-event");
  assert.deepEqual(Object.keys(ownerBody.events[0]!).sort(), [
    "accountEmail", "accountId", "allDay", "description", "end", "eventId", "htmlLink", "id", "start", "status", "title", "timeZone",
  ].sort());
  assert.doesNotMatch(ownerText, /calendar-owner-one-subject|calendar-owner-two-subject|other-calendar-user-subject|refresh-fixture|private-creator|not-for-ui/);

  const otherResponse = await fetch(`${fixture.baseUrl}/api/google/calendar/events?${query}&userId=${USER_ID}`, {
    headers: { cookie: otherCookie },
  });
  const otherBody = await otherResponse.json() as { events: Array<{ eventId: string; accountId: string }> };
  assert.equal(otherResponse.status, 200);
  assert.deepEqual(otherBody.events.map((event) => [event.eventId, event.accountId]), [["other-user-event", otherAccount.id]]);

  const ownerCalls = calls.filter((call) => call.userId === USER_ID);
  const otherCalls = calls.filter((call) => call.userId === OTHER_USER_ID);
  assert.equal(ownerCalls.length, 3);
  assert.equal(otherCalls.length, 1);
  assert.equal(ownerCalls.find((call) => call.params.pageToken === "owner-one-next-page")?.accountId, ownerOne.id);
  for (const call of calls) {
    assert.equal(call.params.calendarId, "primary");
    assert.equal(call.params.timeMin, "2026-01-01T00:00:00Z");
    assert.equal(call.params.timeMax, "2026-01-08T00:00:00Z");
    assert.equal(call.params.singleEvents, true);
    assert.equal(call.params.orderBy, "startTime");
    assert.equal(call.params.maxResults, 2500);
  }
  // One required-scope check per connected account, never per page.
  assert.deepEqual(scopes, Array.from({ length: 3 }, () => [GOOGLE_API_SCOPE_CATALOG["google-calendar"].read]));
  assert.deepEqual(writes, []);
});

test("Google Calendar event route enforces session, allowed origin, and bounded single RFC3339 time bounds", async () => {
  const calls: CalendarListCall[] = [];
  const scopes: string[][] = [];
  const writes: string[] = [];
  const fixture = await startFixture({
    dataDir: await temporaryDataDir(),
    config: GOOGLE_CONFIG,
    googleApi: calendarGateway(async () => ({ data: { items: [] } }), calls, scopes, writes),
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const endpoint = new URL("/api/google/calendar/events", fixture.baseUrl);
  const oneDay = "2026-01-01T00:00:00Z";
  const validMax = "2026-01-02T00:00:00Z";
  const get = (url: URL, headers: Record<string, string> = { cookie }) => fetch(url, { headers });

  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await get(new URL(`${endpoint}?timeMin=${oneDay}&timeMax=${validMax}`), { cookie, origin: "https://attacker.example" })).status, 403);
  for (const invalid of [
    `${endpoint}?timeMin=${oneDay}`,
    `${endpoint}?timeMin=${oneDay}&timeMin=${oneDay}&timeMax=${validMax}`,
    `${endpoint}?timeMin=2026-01-01&timeMax=${validMax}`,
    `${endpoint}?timeMin=2026-02-30T00%3A00%3A00Z&timeMax=${validMax}`,
    `${endpoint}?timeMin=${validMax}&timeMax=${validMax}`,
    `${endpoint}?timeMin=${oneDay}&timeMax=2027-01-02T00%3A00%3A00.001Z`,
  ]) {
    assert.equal((await get(new URL(invalid))).status, 400, invalid);
  }
  const exactly366Days = new URL(endpoint);
  exactly366Days.searchParams.set("timeMin", oneDay);
  exactly366Days.searchParams.set("timeMax", "2027-01-02T00:00:00Z");
  const accepted = await get(exactly366Days);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { configured: true, connected: false, events: [], errors: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
});

test("Google Calendar provider failures are reported safely per account", async () => {
  const dataDir = await temporaryDataDir();
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY });
  const failing = await store.save({
    userId: USER_ID,
    service: "google-calendar",
    googleSub: "provider-error-account",
    email: "failure@example.com",
    refreshToken: "provider-error-refresh-fixture",
  });
  const healthy = await store.save({
    userId: USER_ID,
    service: "google-calendar",
    googleSub: "healthy-calendar-account",
    email: "healthy@example.com",
    refreshToken: "healthy-calendar-refresh-fixture",
  });
  const calls: CalendarListCall[] = [];
  const scopes: string[][] = [];
  const writes: string[] = [];
  const providerDetail = "private-google-provider-error-detail";
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    googleApi: calendarGateway(async ({ accountId }) => {
      if (accountId === failing.id) throw new Error(providerDetail);
      return { data: { items: [{
        id: "healthy-event",
        summary: "Available event",
        start: { dateTime: "2026-01-01T09:00:00Z" },
        end: { dateTime: "2026-01-01T09:30:00Z" },
      }] } };
    }, calls, scopes, writes),
  });
  const signedIn = await login(fixture);
  const response = await fetch(`${fixture.baseUrl}/api/google/calendar/events?timeMin=2026-01-01T00%3A00%3A00Z&timeMax=2026-01-02T00%3A00%3A00Z`, {
    headers: { cookie: cookiePair(signedIn.response) },
  });
  const text = await response.text();
  const body = JSON.parse(text) as { connected: boolean; events: Array<{ eventId: string }>; errors: Array<{ accountId: string; email: string; error: string }> };
  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  assert.deepEqual(body.events.map((event) => event.eventId), ["healthy-event"]);
  assert.deepEqual(body.errors, [{
    accountId: failing.id,
    email: "failure@example.com",
    error: "Could not load all events from this calendar.",
  }]);
  assert.doesNotMatch(text, new RegExp(providerDetail));
  assert.deepEqual(writes, []);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.accountId === healthy.id), true);
});

function fixtureRequestsAt(fixture: Fixture, pathname: string): CapturedRequest[] {
  return fixture.requests.filter((request) => request.url.pathname === pathname);
}

test("encrypts refresh tokens with AES-GCM, authenticates tampering and wrong keys, and fails on corrupt files", async () => {
  const dataDir = await temporaryDataDir();
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY });
  await chmod(dataDir, 0o755);
  const metadata = await store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "encrypted-subject",
    email: "encrypted@example.com",
    refreshToken: "round-trip-refresh-token",
  });
  assert.equal(await store.refreshTokenForAccount(USER_ID, "gmail", metadata.id), "round-trip-refresh-token");
  assert.deepEqual(await store.list(USER_ID), [{ ...metadata }]);
  assert.doesNotMatch(await readFile(store.filePath, "utf8"), /round-trip-refresh-token/);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  await chmod(store.filePath, 0o644);
  assert.deepEqual(await store.list(USER_ID), [{ ...metadata }]);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal(parseTokenEncryptionKey(GOOGLE_TOKEN_KEY).length, 32);
  assert.throws(() => parseTokenEncryptionKey(Buffer.alloc(31, 1).toString("base64")), /invalid/);
  const wrongKey = new GoogleConnectionStore({ dataDir, encryptionKey: Buffer.alloc(32, 0x33).toString("hex") });
  await assert.rejects(wrongKey.refreshTokenForAccount(USER_ID, "gmail", metadata.id), /authentication failed/);
  await assert.rejects(wrongKey.list(USER_ID), /authentication failed/);

  await store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "encrypted-subject",
    email: "encrypted@example.com",
    refreshToken: "replacement-refresh-token",
  });
  assert.equal(await store.deleteIfRefreshTokenMatches(USER_ID, "gmail", metadata.id, "round-trip-refresh-token"), "changed");
  assert.equal(await store.refreshTokenForAccount(USER_ID, "gmail", metadata.id), "replacement-refresh-token");

  const parsed = JSON.parse(await readFile(store.filePath, "utf8")) as {
    connections: Array<{ refreshToken: { ciphertext: string }; [key: string]: unknown }>;
  };
  Object.assign(parsed.connections[0]!, { refreshTokenPlaintext: "must-not-be-accepted" });
  await writeFile(store.filePath, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(store.list(USER_ID), /corrupt/);
  delete parsed.connections[0]!.refreshTokenPlaintext;
  const original = parsed.connections[0]!.refreshToken.ciphertext;
  parsed.connections[0]!.refreshToken.ciphertext = `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`;
  await writeFile(store.filePath, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(store.refreshTokenForAccount(USER_ID, "gmail", metadata.id), /authentication failed/);

  await writeFile(store.filePath, "{not valid json", { mode: 0o600 });
  await assert.rejects(store.list(USER_ID), /corrupt/);
});

test("disconnect revokes only the selected service account and deletes local data after an invalid-token response", async () => {
  const dataDir = await temporaryDataDir();
  const fixture = await startFixture({
    dataDir,
    config: GOOGLE_CONFIG,
    google: {
      exchanges: {
        gmail: { access_token: "gmail-access", refresh_token: "gmail-refresh-only" },
        calendar: { access_token: "calendar-access", refresh_token: "calendar-refresh-only" },
      },
      userinfoByAccessToken: {
        "gmail-access": { sub: "gmail-sub", email: "gmail@example.com", email_verified: true },
        "calendar-access": { sub: "calendar-sub", email: "calendar@example.com", email_verified: true },
      },
      revokeStatus: 400,
    },
  });
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  for (const [service, code] of [["gmail", "gmail"], ["google-calendar", "calendar"]] as const) {
    const flow = await beginGoogleConnect(fixture, cookie, service);
    assert.ok(flow.flow);
    assert.equal((await completeGoogleConnect(fixture, flow.flow, cookie, code)).status, 303);
  }
  const listed = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
  const accounts = (await listed.json() as { accounts: Array<{ service: string; id: string }> }).accounts;
  const calendarId = accounts.find((account) => account.service === "google-calendar")!.id;
  const gmailId = accounts.find((account) => account.service === "gmail")!.id;

  const wrongService = await fetch(`${fixture.baseUrl}/api/google/connections/gmail/${calendarId}`, {
    method: "DELETE",
    headers: { cookie, origin: "http://127.0.0.1:5199" },
  });
  assert.equal(wrongService.status, 404);
  assert.equal(fixtureRequestsAt(fixture, "/revoke").length, 0);

  const disconnected = await fetch(`${fixture.baseUrl}/api/google/connections/google-calendar/${calendarId}`, {
    method: "DELETE",
    headers: { cookie, origin: "http://127.0.0.1:5199" },
  });
  assert.equal(disconnected.status, 200);
  const responseText = await disconnected.text();
  assert.deepEqual(JSON.parse(responseText), { ok: true, disconnected: true });
  assert.doesNotMatch(responseText, /calendar-refresh-only|gmail-refresh-only/);
  const revocation = fixtureRequestsAt(fixture, "/revoke")[0]!;
  assert.equal(revocation.init.method, "POST");
  assert.equal(new URLSearchParams(revocation.body).get("token"), "calendar-refresh-only");

  const afterDisconnect = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
  const remaining = (await afterDisconnect.json() as { accounts: Array<{ service: string; id: string }> }).accounts;
  assert.deepEqual(remaining.map((account) => [account.service, account.id]), [["gmail", gmailId]]);
  const encryptedFile = await readFile(join(dataDir, "google-connections.json"), "utf8");
  assert.doesNotMatch(encryptedFile, /calendar-refresh-only|gmail-refresh-only/);
  assert.equal(await new GoogleConnectionStore({ dataDir, encryptionKey: GOOGLE_TOKEN_KEY })
    .refreshTokenForAccount(USER_ID, "google-calendar", calendarId), undefined);
});

test("missing Google config leaves connectors unavailable and never reports connected accounts", async () => {
  const fixture = await startFixture({ dataDir: await temporaryDataDir() });
  const unsigned = await fetch(`${fixture.baseUrl}/api/google/connections`);
  assert.equal(unsigned.status, 401);
  const signedIn = await login(fixture);
  const cookie = cookiePair(signedIn.response);
  const listing = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
  assert.deepEqual(await listing.json(), {
    accounts: [],
    configured: false,
    services: { gmail: false, "google-calendar": false },
  });
  const connect = await beginGoogleConnect(fixture, cookie, "gmail");
  assert.equal(connect.response.status, 503);
  assert.equal(connect.response.headers.get("location"), null);
});

test("keeps each connector unavailable when any required Google setting is missing", async () => {
  const incomplete: Array<{ name: string; config: Partial<RelayBffConfig> }> = [
    { name: "client ID", config: { googleOAuthClients: { gmail: { clientSecret: "gmail-client-secret" } } } },
    { name: "client secret", config: { googleOAuthClients: { gmail: { clientId: "gmail-client-id" } } } },
    { name: "redirect URI", config: { googleRedirectUri: undefined } },
    { name: "encryption key", config: { googleTokenEncryptionKey: undefined } },
  ];
  for (const { name, config } of incomplete) {
    const fixture = await startFixture({ dataDir: await temporaryDataDir(), config: { ...GOOGLE_CONFIG, ...config } });
    const signedIn = await login(fixture);
    const cookie = cookiePair(signedIn.response);
    const status = await fetch(`${fixture.baseUrl}/api/google/connections`, { headers: { cookie } });
    const body = await status.json() as { services: Record<string, boolean> };
    assert.equal(body.services.gmail, false, `${name} should leave Gmail unavailable`);
    const connect = await beginGoogleConnect(fixture, cookie, "gmail");
    assert.equal(connect.response.status, 503, `${name} should disable Connect`);
    assert.equal(connect.response.headers.get("location"), null);
  }
});

test("lifts only well-formed login display claims out of Supabase metadata", () => {
  const photo = "https://lh3.googleusercontent.com/a-";
  assert.deepEqual(
    supabaseDisplayClaims({ id: "u", user_metadata: { full_name: " Ada Lovelace ", avatar_url: photo } }),
    { displayName: "Ada Lovelace", avatarUrl: photo },
  );
  assert.deepEqual(
    supabaseDisplayClaims({ id: "u", user_metadata: { name: "Ada", picture: photo } }),
    { displayName: "Ada", avatarUrl: photo },
  );
  // Display-only: anything missing or malformed is omitted, never fatal.
  for (const profile of [
    {},
    { user_metadata: null },
    { user_metadata: { full_name: "   ", avatar_url: "http://lh3.googleusercontent.com/a" } },
    { user_metadata: { full_name: "x".repeat(121), avatar_url: "https://attacker.example.test/a.png" } },
    { user_metadata: { full_name: 7, avatar_url: ["https://lh3.googleusercontent.com/a"] } },
  ]) assert.deepEqual(supabaseDisplayClaims(profile), {});
});

test("permits only Google image hosts over HTTPS for login photos", () => {
  for (const url of [
    "https://lh3.googleusercontent.com/a-",
    "https://lh6.googleusercontent.com/a_=s96-c",
    "https://googleusercontent.com/a",
  ]) assert.equal(isPermittedAvatarUrl(url), true, url);
  for (const url of [
    "",
    "http://lh3.googleusercontent.com/a",
    "https://attacker.example.test/a.png",
    "https://googleusercontent.com.evil.test/a",
    "https://lh3.googleusercontent.com/a".padEnd(2049, "x"),
    "not a url",
  ]) assert.equal(isPermittedAvatarUrl(url), false, url);
});

test("hands the provider's name and photo to the Relay session it issues at login", async () => {
  const photo = "https://lh3.googleusercontent.com/a-/photo";
  const fixture = await startFixture({
    authUser: {
      ...VERIFIED_AUTH_USER,
      user_metadata: { full_name: "Ada Lovelace", avatar_url: photo },
    },
  });
  const result = await login(fixture);
  assert.equal(result.response.status, 303);
  const bridge = fixture.requests.find((request) => request.url.pathname === "/api/internal/portal-session")!;
  assert.deepEqual(JSON.parse(bridge.body), {
    userId: USER_ID,
    email: USER_EMAIL,
    scopes: ["client"],
    displayName: "Ada Lovelace",
    avatarUrl: photo,
  });
  // The claims ride the user lookup the sign-in already performs: no second
  // provider request is made to learn the name or the photo.
  assert.equal(fixture.requests.filter((request) => request.url.pathname === "/auth/v1/user").length, 1);
});

test("still issues the session when the provider photo fails the login-photo contract", async () => {
  const fixture = await startFixture({
    authUser: {
      ...VERIFIED_AUTH_USER,
      user_metadata: { full_name: "Ada Lovelace", avatar_url: "https://attacker.example.test/a.png" },
    },
  });
  const result = await login(fixture);
  assert.equal(result.response.status, 303);
  const bridge = fixture.requests.find((request) => request.url.pathname === "/api/internal/portal-session")!;
  // The name still travels; the disallowed host never reaches Relay.
  assert.deepEqual(JSON.parse(bridge.body), {
    userId: USER_ID,
    email: USER_EMAIL,
    scopes: ["client"],
    displayName: "Ada Lovelace",
  });
});
