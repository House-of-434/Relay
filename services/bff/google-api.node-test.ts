import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { google } from "googleapis";

import {
  GoogleApiGateway,
  GoogleConnectionNotFoundError,
  MissingGoogleApiScopesError,
  GOOGLE_API_SCOPE_CATALOG,
  type GoogleOAuthClientFactoryOptions,
} from "./google-api.ts";
import {
  createGoogleServiceRegistry,
  GoogleConnectionStore,
} from "./google-connections.ts";

const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";
const OTHER_USER_ID = "f7cd9c1b-5f39-4892-b37e-baf8ae27c0c5";
const TOKEN_KEY = Buffer.alloc(32, 0x5a).toString("base64");
const OAUTH_SETTINGS = {
  gmail: { clientId: "fixture-gmail-client-id", clientSecret: "fixture-gmail-client-secret" },
  "google-calendar": { clientId: "fixture-calendar-client-id", clientSecret: "fixture-calendar-client-secret" },
};
const REDIRECT_URI = "http://localhost:8798/api/google/oauth/callback";

const temporaryDirectories: string[] = [];
const oauthClients: Array<InstanceType<typeof google.auth.OAuth2>> = [];
const oauthSettings: GoogleOAuthClientFactoryOptions[] = [];

afterEach(async () => {
  oauthClients.length = 0;
  oauthSettings.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-google-api-"));
  temporaryDirectories.push(dataDir);
  const store = new GoogleConnectionStore({ dataDir, encryptionKey: TOKEN_KEY });
  let factoryCalls = 0;
  const gateway = new GoogleApiGateway({
    connectionStore: store,
    clients: createGoogleServiceRegistry(OAUTH_SETTINGS),
    redirectUri: REDIRECT_URI,
    oauthClientFactory: (settings) => {
      factoryCalls += 1;
      oauthSettings.push(settings);
      const auth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
      oauthClients.push(auth);
      return auth;
    },
  });
  return { store, gateway, dataDir, factoryCalls: () => factoryCalls };
}

test("scope catalog uses the official Google scope URIs", () => {
  const scopes: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") scopes.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(GOOGLE_API_SCOPE_CATALOG);

  // The full-mailbox scope is the one Gmail scope published outside the
  // googleapis auth prefix; prefixing it yields a URI Google never grants.
  assert.equal(GOOGLE_API_SCOPE_CATALOG.gmail.fullMailbox, "https://mail.google.com/");
  const outsideAuthPrefix = scopes.filter(
    (scope) => !scope.startsWith("https://www.googleapis.com/auth/") && scope !== "https://mail.google.com/",
  );
  assert.deepEqual(outsideAuthPrefix, []);
  assert.equal(new Set(scopes).size, scopes.length, "scope catalog must not contain duplicates");
});

test("isolates Google credentials by verified user, service, and account", async () => {
  const fixture = await createFixture();
  const gmail = await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "owner-gmail-subject",
    email: "owner@example.com",
    refreshToken: "owner-gmail-refresh-token-fixture",
  });

  await assert.rejects(
    fixture.gateway.withClient(OTHER_USER_ID, "gmail", gmail.id, [GOOGLE_API_SCOPE_CATALOG.gmail.read], () => "unused"),
    GoogleConnectionNotFoundError,
  );
  await assert.rejects(
    fixture.gateway.withClient(USER_ID, "google-calendar", gmail.id, [GOOGLE_API_SCOPE_CATALOG["google-calendar"].read], () => "unused"),
    GoogleConnectionNotFoundError,
  );
  assert.equal(fixture.factoryCalls(), 0);
});

test("refuses operations before client creation when required scopes are missing, including Gmail send", async () => {
  const fixture = await createFixture();
  const gmail = await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "scoped-gmail-subject",
    email: "scoped@example.com",
    refreshToken: "scoped-gmail-refresh-token-fixture",
  });
  let operationRan = false;

  await assert.rejects(
    fixture.gateway.withClient(USER_ID, "gmail", gmail.id, [GOOGLE_API_SCOPE_CATALOG.gmail.send], () => {
      operationRan = true;
    }),
    (error: unknown) => {
      assert.ok(error instanceof MissingGoogleApiScopesError);
      assert.deepEqual(error.missingScopes, [GOOGLE_API_SCOPE_CATALOG.gmail.send]);
      return true;
    },
  );
  assert.equal(operationRan, false);
  assert.equal(fixture.factoryCalls(), 0);
});

test("normalizes granted scopes and preserves them with the refresh token on reauthorization", async () => {
  const fixture = await createFixture();
  const initialScopes = [GOOGLE_API_SCOPE_CATALOG.gmail.send, GOOGLE_API_SCOPE_CATALOG.gmail.read];
  const gmail = await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "reauthorization-gmail-subject",
    email: "reauthorization@example.com",
    refreshToken: "reauthorization-refresh-token-fixture",
    scopes: [...initialScopes, GOOGLE_API_SCOPE_CATALOG.gmail.read],
  });

  await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "reauthorization-gmail-subject",
    email: "reauthorization@example.com",
    scopes: [GOOGLE_API_SCOPE_CATALOG.gmail.drafts, GOOGLE_API_SCOPE_CATALOG.gmail.read],
  });

  const credential = await fixture.store.internalCredentialForAccount(USER_ID, "gmail", gmail.id);
  assert.equal(credential?.refreshToken === "reauthorization-refresh-token-fixture", true);
  assert.deepEqual(credential?.scopes, [
    GOOGLE_API_SCOPE_CATALOG.gmail.drafts,
    GOOGLE_API_SCOPE_CATALOG.gmail.read,
    GOOGLE_API_SCOPE_CATALOG.gmail.send,
  ]);
});

test("selects the complete generated Gmail v1 and Calendar v3 typed clients", async () => {
  const fixture = await createFixture();
  const gmail = await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "typed-gmail-subject",
    email: "gmail@example.com",
    refreshToken: "typed-gmail-refresh-token-fixture",
  });
  const calendar = await fixture.store.save({
    userId: USER_ID,
    service: "google-calendar",
    googleSub: "typed-calendar-subject",
    email: "calendar@example.com",
    refreshToken: "typed-calendar-refresh-token-fixture",
  });

  const gmailApi = await fixture.gateway.withClient(
    USER_ID,
    "gmail",
    gmail.id,
    [GOOGLE_API_SCOPE_CATALOG.gmail.read],
    (client) => ({
      messages: typeof client.users.messages.list === "function",
      drafts: typeof client.users.drafts.create === "function",
      labels: typeof client.users.labels.list === "function",
      settings: typeof client.users.settings.filters.list === "function",
    }),
  );
  const calendarApi = await fixture.gateway.withClient(
    USER_ID,
    "google-calendar",
    calendar.id,
    [GOOGLE_API_SCOPE_CATALOG["google-calendar"].read],
    (client) => ({
      events: typeof client.events.insert === "function",
      calendarList: typeof client.calendarList.list === "function",
      freeBusy: typeof client.freebusy.query === "function",
      acl: typeof client.acl.list === "function",
      settings: typeof client.settings.list === "function",
    }),
  );

  assert.deepEqual(gmailApi, { messages: true, drafts: true, labels: true, settings: true });
  assert.deepEqual(calendarApi, { events: true, calendarList: true, freeBusy: true, acl: true, settings: true });
  assert.equal(oauthSettings.length, 2);
  assert.equal(oauthSettings[0]?.clientId === OAUTH_SETTINGS.gmail.clientId, true);
  assert.equal(oauthSettings[0]?.clientSecret === OAUTH_SETTINGS.gmail.clientSecret, true);
  assert.equal(oauthSettings[0]?.redirectUri === REDIRECT_URI, true);
  assert.equal(oauthSettings[1]?.clientId === OAUTH_SETTINGS["google-calendar"].clientId, true);
  assert.equal(oauthSettings[1]?.clientSecret === OAUTH_SETTINGS["google-calendar"].clientSecret, true);
  assert.equal(oauthSettings[1]?.redirectUri === REDIRECT_URI, true);
});

test("persists a rotated refresh token after the trusted API callback completes", async () => {
  const fixture = await createFixture();
  const gmail = await fixture.store.save({
    userId: USER_ID,
    service: "gmail",
    googleSub: "rotation-gmail-subject",
    email: "rotation@example.com",
    refreshToken: "original-refresh-token-fixture",
  });
  const replacementRefreshToken = "replacement-refresh-token-fixture";
  const accessToken = "temporary-access-token-fixture";

  const available = await fixture.gateway.withClient(
    USER_ID,
    "gmail",
    gmail.id,
    [GOOGLE_API_SCOPE_CATALOG.gmail.read],
    (client) => {
      oauthClients[0]!.emit("tokens", {
        access_token: accessToken,
        refresh_token: replacementRefreshToken,
      });
      return typeof client.users.messages.list === "function";
    },
  );

  assert.equal(available, true);
  const credential = await fixture.store.internalCredentialForAccount(USER_ID, "gmail", gmail.id);
  assert.equal(credential?.refreshToken === replacementRefreshToken, true);
  const encryptedStore = await readFile(join(fixture.dataDir, "google-connections.json"), "utf8");
  assert.equal(encryptedStore.includes("original-refresh-token-fixture"), false);
  assert.equal(encryptedStore.includes(replacementRefreshToken), false);
  assert.equal(encryptedStore.includes(accessToken), false);
});
