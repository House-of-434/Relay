import { google, type calendar_v3, type gmail_v1 } from "googleapis";

import {
  type GoogleConnectionStore,
  type GoogleOAuthClientSettings,
  type GoogleService,
  type GoogleServiceClient,
} from "./google-connections.ts";

const GOOGLE_AUTH_SCOPE = "https://www.googleapis.com/auth/";

export const GOOGLE_API_SCOPE_CATALOG = Object.freeze({
  gmail: Object.freeze({
    // The only Gmail scope that is not under the googleapis auth prefix.
    fullMailbox: "https://mail.google.com/",
    read: `${GOOGLE_AUTH_SCOPE}gmail.readonly`,
    drafts: `${GOOGLE_AUTH_SCOPE}gmail.compose`,
    send: `${GOOGLE_AUTH_SCOPE}gmail.send`,
    insert: `${GOOGLE_AUTH_SCOPE}gmail.insert`,
    modify: `${GOOGLE_AUTH_SCOPE}gmail.modify`,
    metadata: `${GOOGLE_AUTH_SCOPE}gmail.metadata`,
    labels: `${GOOGLE_AUTH_SCOPE}gmail.labels`,
    settings: Object.freeze({
      basic: `${GOOGLE_AUTH_SCOPE}gmail.settings.basic`,
      sharing: `${GOOGLE_AUTH_SCOPE}gmail.settings.sharing`,
    }),
    addons: Object.freeze({
      currentActionCompose: `${GOOGLE_AUTH_SCOPE}gmail.addons.current.action.compose`,
      currentMessageAction: `${GOOGLE_AUTH_SCOPE}gmail.addons.current.message.action`,
      currentMessageMetadata: `${GOOGLE_AUTH_SCOPE}gmail.addons.current.message.metadata`,
      currentMessageReadonly: `${GOOGLE_AUTH_SCOPE}gmail.addons.current.message.readonly`,
    }),
  }),
  "google-calendar": Object.freeze({
    full: `${GOOGLE_AUTH_SCOPE}calendar`,
    read: `${GOOGLE_AUTH_SCOPE}calendar.readonly`,
    eventsWrite: `${GOOGLE_AUTH_SCOPE}calendar.events`,
    eventsRead: `${GOOGLE_AUTH_SCOPE}calendar.events.readonly`,
    freeBusy: `${GOOGLE_AUTH_SCOPE}calendar.freebusy`,
    eventsFreeBusy: `${GOOGLE_AUTH_SCOPE}calendar.events.freebusy`,
    eventsOwned: `${GOOGLE_AUTH_SCOPE}calendar.events.owned`,
    eventsOwnedRead: `${GOOGLE_AUTH_SCOPE}calendar.events.owned.readonly`,
    eventsPublicRead: `${GOOGLE_AUTH_SCOPE}calendar.events.public.readonly`,
    calendarListWrite: `${GOOGLE_AUTH_SCOPE}calendar.calendarlist`,
    calendarListRead: `${GOOGLE_AUTH_SCOPE}calendar.calendarlist.readonly`,
    calendarsWrite: `${GOOGLE_AUTH_SCOPE}calendar.calendars`,
    calendarsRead: `${GOOGLE_AUTH_SCOPE}calendar.calendars.readonly`,
    acl: `${GOOGLE_AUTH_SCOPE}calendar.acls`,
    aclRead: `${GOOGLE_AUTH_SCOPE}calendar.acls.readonly`,
    settings: `${GOOGLE_AUTH_SCOPE}calendar.settings.readonly`,
    appCreated: `${GOOGLE_AUTH_SCOPE}calendar.app.created`,
    addons: Object.freeze({
      execute: `${GOOGLE_AUTH_SCOPE}calendar.addons.execute`,
      currentEventRead: `${GOOGLE_AUTH_SCOPE}calendar.addons.current.event.read`,
      currentEventWrite: `${GOOGLE_AUTH_SCOPE}calendar.addons.current.event.write`,
    }),
  }),
} as const);

type ScopeLeaf<T> = T extends string ? T : T extends object ? { [K in keyof T]: ScopeLeaf<T[K]> }[keyof T] : never;
export type GoogleApiScope = ScopeLeaf<typeof GOOGLE_API_SCOPE_CATALOG>;
export type GoogleApiClient = gmail_v1.Gmail | calendar_v3.Calendar;
export type GoogleApiClientFor<Service extends GoogleService> = Service extends "gmail" ? gmail_v1.Gmail : calendar_v3.Calendar;

export interface GoogleOAuthClientFactoryOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleOAuthClientFactory = (
  options: GoogleOAuthClientFactoryOptions,
) => InstanceType<typeof google.auth.OAuth2>;

export class GoogleConnectionNotFoundError extends Error {
  constructor() {
    super("Google connection was not found");
    this.name = "GoogleConnectionNotFoundError";
  }
}

export class GoogleApiNotConfiguredError extends Error {
  constructor() {
    super("Google API service is not configured");
    this.name = "GoogleApiNotConfiguredError";
  }
}

export class InvalidGoogleApiScopeError extends Error {
  constructor() {
    super("Google API required scopes are invalid for this service");
    this.name = "InvalidGoogleApiScopeError";
  }
}

export class MissingGoogleApiScopesError extends Error {
  readonly missingScopes: readonly GoogleApiScope[];

  constructor(missingScopes: readonly GoogleApiScope[]) {
    super("Google connection is missing scopes required for this operation");
    this.name = "MissingGoogleApiScopesError";
    this.missingScopes = [...missingScopes];
  }
}

export interface GoogleApiGatewayOptions {
  connectionStore: GoogleConnectionStore;
  clients: Record<GoogleService, GoogleServiceClient>;
  redirectUri?: string;
  oauthClientFactory?: GoogleOAuthClientFactory;
}

const SERVICE_SCOPES: Record<GoogleService, ReadonlySet<string>> = {
  gmail: new Set(flattenScopes(GOOGLE_API_SCOPE_CATALOG.gmail)),
  "google-calendar": new Set(flattenScopes(GOOGLE_API_SCOPE_CATALOG["google-calendar"])),
};

function flattenScopes(value: string | object): string[] {
  if (typeof value === "string") return [value];
  return Object.values(value).flatMap((nested) => flattenScopes(nested as string | object));
}

function validateRequiredScopes(service: GoogleService, scopes: readonly GoogleApiScope[]): void {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 30) {
    throw new InvalidGoogleApiScopeError();
  }
  const allowed = SERVICE_SCOPES[service];
  if (scopes.some((scope) => typeof scope !== "string" || !allowed.has(scope))) {
    throw new InvalidGoogleApiScopeError();
  }
}

/**
 * Server-only access to the complete generated Gmail v1 or Calendar v3 client.
 * Callers must pass the user ID from a verified BFF session and choose the
 * operation's required scopes in trusted server code; neither is a model input.
 */
export class GoogleApiGateway {
  private readonly connectionStore: GoogleConnectionStore;
  private readonly clients: Record<GoogleService, GoogleServiceClient>;
  private readonly redirectUri: string | undefined;
  private readonly oauthClientFactory: GoogleOAuthClientFactory;

  constructor(options: GoogleApiGatewayOptions) {
    this.connectionStore = options.connectionStore;
    this.clients = options.clients;
    this.redirectUri = options.redirectUri;
    this.oauthClientFactory = options.oauthClientFactory ?? (({ clientId, clientSecret, redirectUri }) =>
      new google.auth.OAuth2(clientId, clientSecret, redirectUri));
  }

  async withClient<Service extends GoogleService, Result>(
    userId: string,
    service: Service,
    accountId: string,
    requiredScopes: readonly GoogleApiScope[],
    operation: (client: GoogleApiClientFor<Service>) => Result | Promise<Result>,
  ): Promise<Result> {
    validateRequiredScopes(service, requiredScopes);

    const credential = await this.connectionStore.internalCredentialForAccount(userId, service, accountId);
    if (!credential) throw new GoogleConnectionNotFoundError();

    const missingScopes = requiredScopes.filter((scope) => !credential.scopes.includes(scope));
    if (missingScopes.length) throw new MissingGoogleApiScopesError(missingScopes);

    const clientSettings: GoogleOAuthClientSettings = this.clients[service];
    if (!clientSettings.clientId || !clientSettings.clientSecret || !this.redirectUri) {
      throw new GoogleApiNotConfiguredError();
    }

    const auth = this.oauthClientFactory({
      clientId: clientSettings.clientId,
      clientSecret: clientSettings.clientSecret,
      redirectUri: this.redirectUri,
    });

    let latestRefreshToken = credential.refreshToken;
    let pendingPersistence = Promise.resolve();
    let persistenceError: Error | undefined;
    auth.on("tokens", (tokens) => {
      const replacement = tokens.refresh_token;
      if (typeof replacement !== "string" || !replacement || replacement === latestRefreshToken) return;
      const expectedRefreshToken = latestRefreshToken;
      latestRefreshToken = replacement;
      pendingPersistence = pendingPersistence.then(async () => {
        const result = await this.connectionStore.replaceRefreshTokenForAccount({
          userId,
          service,
          id: accountId,
          googleSub: credential.googleSub,
          expectedRefreshToken,
          refreshToken: replacement,
        });
        if (result !== "updated") throw new Error("Google refresh token rotation could not be persisted");
      }).catch(() => {
        persistenceError ??= new Error("Google refresh token rotation could not be persisted");
      });
    });
    auth.setCredentials({ refresh_token: credential.refreshToken });

    const client = (service === "gmail"
      ? google.gmail({ version: "v1", auth })
      : google.calendar({ version: "v3", auth })) as GoogleApiClientFor<Service>;

    let result!: Result;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await operation(client);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    await pendingPersistence;
    if (persistenceError) throw persistenceError;
    if (operationFailed) throw operationError;
    return result;
  }
}
