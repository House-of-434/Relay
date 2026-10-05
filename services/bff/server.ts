import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";
import { GOOGLE_API_SCOPE_CATALOG, GoogleApiGateway } from "./google-api.ts";
import { handleInternalGmail, isInternalGmailPath } from "./gmail-internal.ts";
import { handleInternalCalendar, isInternalCalendarPath } from "./calendar-internal.ts";
import {
  GOOGLE_SERVICE_REGISTRY,
  GoogleConnectionStore,
  MissingGoogleRefreshTokenError,
  createGoogleServiceRegistry,
  isGoogleService,
  parseTokenEncryptionKey,
  type GoogleOAuthClientSettings,
  type GoogleServiceClient,
  type GoogleService,
} from "./google-connections.ts";
import type {
  GoogleCalendarEvent,
  GoogleCalendarEventTime,
} from "../../packages/relay-shared/google-calendar.ts";

const COOKIE_NAME = "relay_bff";
const OAUTH_STATE_COOKIE_NAME = "relay_bff_oauth_state";
const GOOGLE_OAUTH_STATE_COOKIE_PREFIX = "relay_google_oauth_state_";
const DEFAULT_BFF_PORT = 8798;
const DEFAULT_RELAY_PORT = 8799;
const DEFAULT_UI_PORT = 5199;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_MS;
const MAX_LIVE_SESSIONS = 500;
const MAX_PENDING_LOGINS = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_SESSION_TOKEN_PATTERN = /^relay_sess_[A-Za-z0-9_-]{43}$/;
const OAUTH_CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const RFC3339_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const CALENDAR_EVENT_PAGE_SIZE = 2500;
const CALENDAR_EVENT_TOTAL_CAP = 10_000;
const CALENDAR_EVENT_PAGE_CAP = 100;
const CALENDAR_EVENT_LOAD_ERROR = "Could not load all events from this calendar.";
const CALENDAR_EVENT_LIMIT_ERROR = "Event limit reached; this calendar is incomplete.";

export interface RelayBffConfig {
  supabaseProjectUrl: string;
  supabaseAnonKey: string;
  relayBffCapability: string;
  relayBffPublicUrl: string;
  bffPort: number;
  ombPort: number;
  uiPort: number;
  sessionTtlMs?: number;
  oauthStateTtlMs?: number;
  googleOAuthClients?: Partial<Record<GoogleService, GoogleOAuthClientSettings>>;
  googleRedirectUri?: string;
  googleTokenEncryptionKey?: string;
  relayToolActorSecret?: string;
  dataDir?: string;
}

export interface VerifiedSupabaseIdentity {
  subject: string;
  email: string;
  /** Login-time display claims from the provider metadata. Display-only:
   * never part of any authentication or authorization decision. */
  displayName?: string;
  avatarUrl?: string;
}

interface BffSession extends VerifiedSupabaseIdentity {
  relayToken: string;
  relaySessionId: string;
  expiresAt: number;
}

interface OAuthTransaction {
  codeVerifier: string;
  expiresAt: number;
}

interface BffOptions {
  config: RelayBffConfig;
  fetcher?: typeof fetch;
  jwksFetcher?: typeof fetch;
  now?: () => number;
  googleApi?: GoogleApiGateway;
}

export interface RelayBffApplication {
  server: Server;
  close: () => Promise<void>;
  googleApi: GoogleApiGateway;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a valid TCP port`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): RelayBffConfig {
  const missing = ["SUPABASE_PROJECT_URL", "SUPABASE_ANON_KEY", "RELAY_BFF_CAPABILITY"]
    .filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);

  const bffPort = parsePort(env.RELAY_BFF_PORT, DEFAULT_BFF_PORT, "RELAY_BFF_PORT");
  return validateConfig({
    supabaseProjectUrl: env.SUPABASE_PROJECT_URL!,
    supabaseAnonKey: env.SUPABASE_ANON_KEY!,
    relayBffCapability: env.RELAY_BFF_CAPABILITY!,
    relayToolActorSecret: env.RELAY_TOOL_ACTOR_SECRET,
    relayBffPublicUrl: env.RELAY_BFF_PUBLIC_URL?.trim() || `http://localhost:${bffPort}`,
    bffPort,
    ombPort: parsePort(env.RELAY_PORT, DEFAULT_RELAY_PORT, "RELAY_PORT"),
    uiPort: parsePort(env.RELAY_UI_PORT, DEFAULT_UI_PORT, "RELAY_UI_PORT"),
    googleOAuthClients: {
      gmail: {
        clientId: env[GOOGLE_SERVICE_REGISTRY.gmail.clientIdEnvironmentVariable]?.trim(),
        clientSecret: env[GOOGLE_SERVICE_REGISTRY.gmail.clientSecretEnvironmentVariable]?.trim(),
      },
      "google-calendar": {
        clientId: env[GOOGLE_SERVICE_REGISTRY["google-calendar"].clientIdEnvironmentVariable]?.trim(),
        clientSecret: env[GOOGLE_SERVICE_REGISTRY["google-calendar"].clientSecretEnvironmentVariable]?.trim(),
      },
    },
    googleRedirectUri: env.RELAY_GOOGLE_REDIRECT_URI?.trim(),
    googleTokenEncryptionKey: env.RELAY_TOKEN_ENCRYPTION_KEY,
    dataDir: env.RELAY_DATA_DIR?.trim() || join(homedir(), ".relay"),
  });
}

function validateConfig(config: RelayBffConfig): RelayBffConfig {
  let projectUrl: URL;
  try {
    projectUrl = new URL(config.supabaseProjectUrl);
  } catch {
    throw new Error("SUPABASE_PROJECT_URL must be a valid HTTPS project URL");
  }
  if (
    projectUrl.protocol !== "https:" || projectUrl.username || projectUrl.password ||
    projectUrl.pathname !== "/" || projectUrl.search || projectUrl.hash
  ) throw new Error("SUPABASE_PROJECT_URL must be a valid HTTPS project URL");
  let publicUrl: URL;
  try {
    publicUrl = new URL(config.relayBffPublicUrl);
  } catch {
    throw new Error("RELAY_BFF_PUBLIC_URL must be a valid HTTP or HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
    publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash
  ) throw new Error("RELAY_BFF_PUBLIC_URL must be a valid HTTP or HTTPS origin");
  if (!config.supabaseAnonKey.trim()) throw new Error("SUPABASE_ANON_KEY is required");
  if (Buffer.byteLength(config.relayBffCapability) < 32) {
    throw new Error("RELAY_BFF_CAPABILITY must be at least 32 bytes");
  }
  for (const [name, port] of [["RELAY_BFF_PORT", config.bffPort], ["RELAY_PORT", config.ombPort], ["RELAY_UI_PORT", config.uiPort]] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid TCP port`);
  }
  if (config.sessionTtlMs !== undefined && (!Number.isFinite(config.sessionTtlMs) || config.sessionTtlMs <= 0)) {
    throw new Error("BFF session lifetime must be positive");
  }
  if (config.oauthStateTtlMs !== undefined && (
    !Number.isFinite(config.oauthStateTtlMs) || config.oauthStateTtlMs <= 0 ||
    config.oauthStateTtlMs > MAX_OAUTH_STATE_TTL_MS
  )) {
    throw new Error("OAuth state lifetime must be positive and no longer than 10 minutes");
  }
  return {
    ...config,
    supabaseProjectUrl: projectUrl.origin,
    relayBffPublicUrl: publicUrl.origin,
  };
}

function asJwtIdentity(payload: JWTPayload): VerifiedSupabaseIdentity {
  const subject = payload.sub;
  const email = payload.email;
  if (typeof subject !== "string" || !UUID_PATTERN.test(subject)) throw new Error("Invalid Supabase identity");
  if (
    typeof email !== "string" || email.length > 320 || email.trim() !== email ||
    !/^[^\s@]+@houseof434\.com$/i.test(email)
  ) throw new Error("Invalid Supabase identity");
  return { subject, email };
}

function asVerifiedIdentity(jwtIdentity: VerifiedSupabaseIdentity, profile: unknown): VerifiedSupabaseIdentity {
  const id = profile && typeof profile === "object" ? Reflect.get(profile, "id") : undefined;
  const email = profile && typeof profile === "object" ? Reflect.get(profile, "email") : undefined;
  const emailConfirmedAt = profile && typeof profile === "object"
    ? Reflect.get(profile, "email_confirmed_at")
    : undefined;
  const confirmedAt = profile && typeof profile === "object" ? Reflect.get(profile, "confirmed_at") : undefined;
  const hasCanonicalConfirmation = [emailConfirmedAt, confirmedAt].some(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (
    id !== jwtIdentity.subject || typeof email !== "string" || email.length > 320 || email.trim() !== email ||
    email.toLowerCase() !== jwtIdentity.email.toLowerCase() ||
    !/^[^\s@]+@houseof434\.com$/i.test(email) || !hasCanonicalConfirmation
  ) throw new Error("Invalid Supabase identity");
  return { subject: jwtIdentity.subject, email, ...supabaseDisplayClaims(profile) };
}

/** Optional display claims from the provider metadata Supabase maintains.
 * Extracted from the user lookup the login already performs — never a new
 * request. Anything missing or malformed is omitted, never fatal: a sign-in
 * must not fail over a display name or photo. */
export function supabaseDisplayClaims(profile: unknown): Pick<VerifiedSupabaseIdentity, "displayName" | "avatarUrl"> {
  const metadata = profile && typeof profile === "object" ? Reflect.get(profile, "user_metadata") : undefined;
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : undefined;
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const claims: Pick<VerifiedSupabaseIdentity, "displayName" | "avatarUrl"> = {};
  const displayName = firstString("full_name", "name");
  if (displayName && displayName.length <= 120) claims.displayName = displayName;
  const avatarUrl = firstString("avatar_url", "picture");
  if (avatarUrl && isPermittedAvatarUrl(avatarUrl)) claims.avatarUrl = avatarUrl;
  return claims;
}

/** Provider photos are untrusted display data even though Supabase vouched
 * for the login: allow only Google's image hosts over HTTPS, bounded length,
 * so a compromised metadata value cannot point the UI at an arbitrary host. */
const GOOGLE_AVATAR_HOST = /(^|\.)googleusercontent\.com$/i;
const MAX_AVATAR_URL_LENGTH = 2048;

export function isPermittedAvatarUrl(value: string): boolean {
  if (!value || value.length > MAX_AVATAR_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && GOOGLE_AVATAR_HOST.test(url.hostname);
}

export function createSupabaseJwtVerifier(options: {
  projectUrl: string;
  anonKey: string;
  fetcher?: typeof fetch;
  jwksFetcher?: typeof fetch;
  now?: () => number;
}): (accessToken: string) => Promise<VerifiedSupabaseIdentity> {
  const projectUrl = new URL(options.projectUrl);
  const issuer = `${projectUrl.origin}/auth/v1`;
  const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
  const jwksFetcher = options.jwksFetcher ?? fetch;
  const fetcher = options.fetcher ?? fetch;
  const userUrl = new URL("/auth/v1/user", projectUrl);
  const jwks = createRemoteJWKSet(jwksUrl, {
    [customFetch]: (url, init) => jwksFetcher(url, init),
  });
  const now = options.now ?? Date.now;

  return async (accessToken) => {
    try {
      const { payload } = await jwtVerify(accessToken, jwks, {
        algorithms: ["ES256"],
        issuer,
        audience: "authenticated",
        currentDate: new Date(now()),
      });
      const jwtIdentity = asJwtIdentity(payload);
      const response = await fetcher(userUrl, {
        method: "GET",
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${accessToken}`,
        },
        redirect: "error",
      });
      if (!response.ok) throw new Error("Supabase user lookup failed");
      const profile: unknown = await response.json();
      return asVerifiedIdentity(jwtIdentity, profile);
    } catch {
      throw new Error("Invalid Supabase identity");
    }
  };
}

class OAuthTransactions {
  private readonly transactions = new Map<string, OAuthTransaction>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs: number) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  create(): { state: string; codeVerifier: string } {
    this.prune();
    while (this.transactions.size >= MAX_PENDING_LOGINS) {
      const oldest = this.transactions.keys().next().value;
      if (oldest === undefined) break;
      this.transactions.delete(oldest);
    }
    let state: string;
    do state = randomBytes(32).toString("base64url"); while (this.transactions.has(state));
    const codeVerifier = randomBytes(32).toString("base64url");
    this.transactions.set(state, { codeVerifier, expiresAt: this.now() + this.ttlMs });
    return { state, codeVerifier };
  }

  consume(state: string): OAuthTransaction | undefined {
    this.prune();
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    return transaction;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
  }
}

interface GoogleOAuthTransaction {
  codeVerifier: string;
  expiresAt: number;
  service: GoogleService;
  userId: string;
  sessionId: string;
  clientId: string;
}

class GoogleOAuthTransactions {
  private readonly transactions = new Map<string, GoogleOAuthTransaction>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs: number) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  create(input: Omit<GoogleOAuthTransaction, "codeVerifier" | "expiresAt">): { state: string; codeVerifier: string } {
    this.prune();
    while (this.transactions.size >= MAX_PENDING_LOGINS) {
      const oldest = this.transactions.keys().next().value;
      if (oldest === undefined) break;
      this.transactions.delete(oldest);
    }
    let state: string;
    do state = randomBytes(32).toString("base64url"); while (this.transactions.has(state));
    const codeVerifier = randomBytes(32).toString("base64url");
    this.transactions.set(state, { ...input, codeVerifier, expiresAt: this.now() + this.ttlMs });
    return { state, codeVerifier };
  }

  get(state: string): GoogleOAuthTransaction | undefined {
    this.prune();
    return this.transactions.get(state);
  }

  consume(state: string): GoogleOAuthTransaction | undefined {
    const transaction = this.get(state);
    this.transactions.delete(state);
    return transaction;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
  }
}

class BffSessions {
  private readonly sessions = new Map<string, BffSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs: number) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  create(identity: VerifiedSupabaseIdentity, relayToken: string, relaySessionId: string): { id: string; expiresAt: number } {
    this.prune();
    while (this.sessions.size >= MAX_LIVE_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    let id: string;
    do id = randomBytes(32).toString("base64url"); while (this.sessions.has(id));
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(id, { ...identity, relayToken, relaySessionId, expiresAt });
    return { id, expiresAt };
  }

  get(id: string): BffSession | undefined {
    this.prune();
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

function cookieValue(
  req: IncomingMessage,
  name = COOKIE_NAME,
  pattern = /^[A-Za-z0-9_-]{43}$/,
): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length > 8192) return undefined;
  let result: string | undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    if (result !== undefined) return undefined;
    const candidate = item.slice(separator + 1).trim();
    if (!pattern.test(candidate)) return undefined;
    result = candidate;
  }
  return result;
}

function singleQueryValue(url: URL, key: string, pattern: RegExp): string | undefined {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && pattern.test(values[0]!) ? values[0] : undefined;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysByMonth[month - 1]!;
}

function validRfc3339Timestamp(value: string): boolean {
  if (!RFC3339_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return validCalendarDate(year, month, day) && Number.isFinite(Date.parse(value));
}

function calendarEventBounds(url: URL): { timeMin: string; timeMax: string } | undefined {
  const timeMin = singleQueryValue(url, "timeMin", RFC3339_PATTERN);
  const timeMax = singleQueryValue(url, "timeMax", RFC3339_PATTERN);
  if (!timeMin || !timeMax || !validRfc3339Timestamp(timeMin) || !validRfc3339Timestamp(timeMax)) return undefined;
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max - min > 366 * 24 * 60 * 60_000) {
    return undefined;
  }
  return { timeMin, timeMax };
}

function safeCalendarEventTime(value: unknown): GoogleCalendarEventTime | undefined {
  if (!value || typeof value !== "object") return undefined;
  const dateTime = Reflect.get(value, "dateTime");
  const date = Reflect.get(value, "date");
  if (typeof dateTime === "string" && dateTime.length <= 64 && validRfc3339Timestamp(dateTime)) {
    return { dateTime };
  }
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    validCalendarDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    return { date };
  }
  return undefined;
}

function safeCalendarEvent(
  account: { id: string; email: string },
  value: unknown,
): GoogleCalendarEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const eventId = Reflect.get(value, "id");
  const rawStart = Reflect.get(value, "start");
  const rawEnd = Reflect.get(value, "end");
  const start = safeCalendarEventTime(rawStart);
  const end = safeCalendarEventTime(rawEnd);
  if (
    typeof eventId !== "string" || !eventId || eventId.length > 1024 || !start || !end ||
    ("date" in start) !== ("date" in end)
  ) return undefined;

  const rawStatus = Reflect.get(value, "status");
  const status = rawStatus === "cancelled" || rawStatus === "tentative" ? rawStatus : "confirmed";
  const rawTitle = Reflect.get(value, "summary");
  const rawDescription = Reflect.get(value, "description");
  const rawLink = Reflect.get(value, "htmlLink");
  const rawZone = Reflect.get(rawStart as object, "timeZone") ?? Reflect.get(rawEnd as object, "timeZone");
  const event: GoogleCalendarEvent = {
    id: `${account.id}:${eventId}`,
    accountId: account.id,
    accountEmail: account.email,
    eventId,
    title: typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.slice(0, 500) : "Untitled event",
    status,
    start,
    end,
    allDay: "date" in start,
  };
  if (typeof rawDescription === "string" && rawDescription) event.description = rawDescription.slice(0, 4000);
  if (typeof rawLink === "string" && rawLink.length <= 2048) {
    try {
      if (new URL(rawLink).protocol === "https:") event.htmlLink = rawLink;
    } catch {
      // Omit malformed provider links from the UI response.
    }
  }
  if (typeof rawZone === "string" && rawZone.length <= 128) event.timeZone = rawZone;
  return event;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function reject(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  req.resume();
  json(res, status, { error: message });
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  const cookies = Array.isArray(existing) ? existing.map(String) : existing === undefined ? [] : [String(existing)];
  res.setHeader("set-cookie", [...cookies, cookie]);
}

function cookieSecurity(publicUrl: URL): string {
  return publicUrl.protocol === "https:" ? "; Secure" : "";
}

function setOAuthStateCookie(res: ServerResponse, state: string, ttlMs: number, publicUrl: URL): void {
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
  appendSetCookie(
    res,
    `${OAUTH_STATE_COOKIE_NAME}=${state}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(publicUrl)}`,
  );
}

function clearOAuthStateCookie(res: ServerResponse, publicUrl: URL): void {
  appendSetCookie(
    res,
    `${OAUTH_STATE_COOKIE_NAME}=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(publicUrl)}`,
  );
}

function googleOAuthStateCookieName(service: GoogleService): string {
  return `${GOOGLE_OAUTH_STATE_COOKIE_PREFIX}${service.replace("-", "_")}`;
}

function signedGoogleOAuthState(state: string, service: GoogleService, signingKey: string): string {
  const signature = createHmac("sha256", signingKey).update(`${service}\0${state}`).digest("base64url");
  return `${state}.${signature}`;
}

function googleOAuthStateCookieValue(req: IncomingMessage, service: GoogleService, signingKey: string): string | undefined {
  const candidate = cookieValue(
    req,
    googleOAuthStateCookieName(service),
    /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/,
  );
  if (!candidate) return undefined;
  const [state, signature] = candidate.split(".");
  if (!state || !signature) return undefined;
  const expected = createHmac("sha256", signingKey).update(`${service}\0${state}`).digest();
  const received = Buffer.from(signature, "base64url");
  return received.toString("base64url") === signature && received.length === expected.length && timingSafeEqual(received, expected)
    ? state
    : undefined;
}

function setGoogleOAuthStateCookie(
  res: ServerResponse,
  service: GoogleService,
  state: string,
  signingKey: string,
  ttlMs: number,
  publicUrl: URL,
): void {
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
  appendSetCookie(
    res,
    `${googleOAuthStateCookieName(service)}=${signedGoogleOAuthState(state, service, signingKey)}; Path=/api/google/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(publicUrl)}`,
  );
}

function clearGoogleOAuthStateCookie(res: ServerResponse, service: GoogleService, publicUrl: URL): void {
  appendSetCookie(
    res,
    `${googleOAuthStateCookieName(service)}=; Path=/api/google/oauth/callback; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(publicUrl)}`,
  );
}

function setSessionCookie(res: ServerResponse, id: string, ttlMs: number, publicUrl: URL): void {
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
  appendSetCookie(res, `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(publicUrl)}`);
}

function clearSessionCookie(res: ServerResponse, publicUrl: URL): void {
  appendSetCookie(res, `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(publicUrl)}`);
}

function isLocalHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function isAllowedUiOrigin(origin: string, publicUiOrigin: string, uiPort: number): boolean {
  try {
    const parsed = new URL(origin);
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
    const validOrigin = parsed.username === "" && parsed.password === "" &&
      parsed.pathname === "/" && !parsed.search && !parsed.hash;
    return validOrigin && (parsed.origin === publicUiOrigin ||
      (parsed.protocol === "http:" && port === uiPort && isLocalHost(parsed.hostname)));
  } catch {
    return false;
  }
}

const REQUEST_HOP_HEADERS = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "via",
  "authorization", "apikey", "cookie", "forwarded", "x-api-key", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-port", "x-forwarded-prefix", "x-forwarded-proto", "x-real-ip",
]);

const RESPONSE_HOP_HEADERS = new Set([
  "connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
]);

function requestHeaders(req: IncomingMessage, harnessOrigin: string): Headers | undefined {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (REQUEST_HOP_HEADERS.has(lowerName) || lowerName.startsWith("x-supabase-") || rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    headers.set(name, values.join(", "));
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== "string") return undefined;
    headers.set("origin", harnessOrigin);
  }
  return headers;
}

async function sendUpstreamResponse(req: IncomingMessage, res: ServerResponse, response: Response, upstreamOrigin: string): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (RESPONSE_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "location") {
      try {
        const location = new URL(value, upstreamOrigin);
        res.setHeader(name, location.origin === upstreamOrigin ? `${location.pathname}${location.search}${location.hash}` : value);
      } catch {
        res.setHeader(name, value);
      }
      continue;
    }
    res.setHeader(name, value);
  }
  if (req.method === "HEAD" || response.body === null || response.status === 204 || response.status === 304) {
    req.resume();
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

function hasRequestBody(req: IncomingMessage): boolean {
  return req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function googleRedirectUri(config: RelayBffConfig, publicUrl: URL): URL | undefined {
  if (!config.googleRedirectUri) return undefined;
  try {
    const redirectUri = new URL(config.googleRedirectUri);
    if (
      !["http:", "https:"].includes(redirectUri.protocol) || redirectUri.username || redirectUri.password ||
      redirectUri.origin !== publicUrl.origin || redirectUri.pathname !== "/api/google/oauth/callback" ||
      redirectUri.search || redirectUri.hash
    ) return undefined;
    return redirectUri;
  } catch {
    return undefined;
  }
}

function googleServiceConfigured(
  service: GoogleService,
  registry: Record<GoogleService, GoogleServiceClient>,
  config: RelayBffConfig,
  publicUrl: URL,
): boolean {
  const client = registry[service];
  if (!client.clientId?.trim() || !client.clientSecret?.trim() || !googleRedirectUri(config, publicUrl)) return false;
  try {
    parseTokenEncryptionKey(config.googleTokenEncryptionKey);
    return true;
  } catch {
    return false;
  }
}

function googleServiceStatus(
  registry: Record<GoogleService, GoogleServiceClient>,
  config: RelayBffConfig,
  publicUrl: URL,
): Record<GoogleService, boolean> {
  return {
    gmail: googleServiceConfigured("gmail", registry, config, publicUrl),
    "google-calendar": googleServiceConfigured("google-calendar", registry, config, publicUrl),
  };
}

function googleUserIdentity(value: unknown): { sub: string; email: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sub = Reflect.get(value, "sub");
  const email = Reflect.get(value, "email");
  const verified = Reflect.get(value, "email_verified");
  if (
    typeof sub !== "string" || !sub || sub.length > 255 ||
    typeof email !== "string" || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    verified !== true
  ) return undefined;
  return { sub, email };
}

/** Sign-in and connector calls are the ones that fail silently, so record their
 * outcome. Only the path is ever logged: the query string carries OAuth codes. */
const AUTH_LOG_PATHS = /^\/(?:auth|api\/google|api\/internal)\b/;

function logAuthRequest(_req: IncomingMessage, res: ServerResponse, method: string, pathname: string): void {
  if (!AUTH_LOG_PATHS.test(pathname)) return;
  res.on("finish", () => {
    console.log(`[relay-bff] ${method} ${pathname} -> ${res.statusCode}`);
  });
}

function isAllowedRequestOrigin(req: IncomingMessage, publicUrl: URL, uiPort: number): boolean {
  const origin = req.headers.origin;
  return origin === undefined || (
    typeof origin === "string" && isAllowedUiOrigin(origin, publicUrl.origin, uiPort)
  );
}

async function proxyRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  target: URL;
  relayToken?: string;
  fetcher: typeof fetch;
  origin?: string;
}): Promise<void> {
  const { req, res, target, relayToken, fetcher, origin } = options;
  const headers = requestHeaders(req, origin ?? target.origin);
  if (!headers) {
    reject(req, res, 403, "forbidden");
    return;
  }
  if (relayToken !== undefined) headers.set("authorization", `Bearer ${relayToken}`);
  const method = req.method ?? "GET";
  const requestInit: RequestInit & { duplex?: "half" } = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD" && hasRequestBody(req)) {
    requestInit.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    requestInit.duplex = "half";
  }

  const abort = new AbortController();
  const onAborted = () => abort.abort();
  const onClosed = () => { if (!res.writableEnded) abort.abort(); };
  req.once("aborted", onAborted);
  res.once("close", onClosed);
  try {
    const upstream = await fetcher(target, { ...requestInit, signal: abort.signal });
    await sendUpstreamResponse(req, res, upstream, target.origin);
  } catch {
    if (!res.headersSent) json(res, 502, { error: "upstream service unavailable" });
    else if (!res.destroyed) res.destroy();
  } finally {
    req.off("aborted", onAborted);
    res.off("close", onClosed);
  }
}

export function createRelayBff(options: BffOptions): RelayBffApplication {
  const config = validateConfig(options.config);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sessionTtlMs = config.sessionTtlMs ?? SESSION_TTL_MS;
  const oauthStateTtlMs = config.oauthStateTtlMs ?? OAUTH_STATE_TTL_MS;
  const supabaseTokenUrl = new URL("/auth/v1/token?grant_type=pkce", config.supabaseProjectUrl);
  const supabaseAuthorizeUrl = new URL("/auth/v1/authorize", config.supabaseProjectUrl);
  const publicUrl = new URL(config.relayBffPublicUrl);
  const harnessOrigin = `http://127.0.0.1:${config.ombPort}`;
  const harnessBase = new URL(harnessOrigin);
  const bffOrigin = publicUrl.origin;
  const uiLocation = isLocalHost(publicUrl.hostname)
    ? `http://localhost:${config.uiPort}/`
    : `${publicUrl.origin}/`;
  const transactions = new OAuthTransactions(now, oauthStateTtlMs);
  const googleTransactions = new GoogleOAuthTransactions(now, oauthStateTtlMs);
  const sessions = new BffSessions(now, sessionTtlMs);
  const googleRegistry = createGoogleServiceRegistry(config.googleOAuthClients);
  const googleStore = new GoogleConnectionStore({
    dataDir: config.dataDir,
    encryptionKey: config.googleTokenEncryptionKey,
  });
  const googleApi = options.googleApi ?? new GoogleApiGateway({
    connectionStore: googleStore,
    clients: googleRegistry,
    redirectUri: googleRedirectUri(config, publicUrl)?.toString(),
  });
  const verifySupabaseToken = createSupabaseJwtVerifier({
    projectUrl: config.supabaseProjectUrl,
    anonKey: config.supabaseAnonKey,
    fetcher,
    jwksFetcher: options.jwksFetcher,
    now,
  });

  const handleGoogleOAuthCallback = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    const state = singleQueryValue(url, "state", /^[A-Za-z0-9_-]{43}$/);
    const transaction = state ? googleTransactions.get(state) : undefined;
    if (!state || !transaction) {
      reject(req, res, 400, "Google connection could not be completed");
      return;
    }
    const stateCookie = googleOAuthStateCookieValue(req, transaction.service, config.relayBffCapability);
    if (stateCookie !== state) {
      reject(req, res, 400, "Google connection could not be completed");
      return;
    }
    googleTransactions.consume(state);
    clearGoogleOAuthStateCookie(res, transaction.service, publicUrl);

    const activeSessionId = cookieValue(req);
    const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
    if (
      activeSessionId !== transaction.sessionId || !activeSession ||
      activeSession.subject !== transaction.userId
    ) {
      reject(req, res, 401, "The sign-in session changed; reconnect Google");
      return;
    }

    const client = googleRegistry[transaction.service];
    const redirectUri = googleRedirectUri(config, publicUrl);
    if (
      !client.clientId || !client.clientSecret || client.clientId !== transaction.clientId ||
      !redirectUri || !googleServiceConfigured(transaction.service, googleRegistry, config, publicUrl)
    ) {
      reject(req, res, 503, "Google service is not configured");
      return;
    }
    const code = singleQueryValue(url, "code", OAUTH_CODE_PATTERN);
    if (url.searchParams.has("error") || !code) {
      reject(req, res, 400, "Google connection could not be completed");
      return;
    }

    let accessToken: string;
    let refreshToken: string | undefined;
    let grantedScopes: string[] | undefined;
    try {
      const exchanged = await fetcher(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri.toString(),
          grant_type: "authorization_code",
          code_verifier: transaction.codeVerifier,
        }),
        redirect: "error",
      });
      if (!exchanged.ok) throw new Error("Google token exchange failed");
      const tokenBody: unknown = await exchanged.json();
      const candidateAccessToken = tokenBody && typeof tokenBody === "object" ? Reflect.get(tokenBody, "access_token") : undefined;
      const candidateRefreshToken = tokenBody && typeof tokenBody === "object" ? Reflect.get(tokenBody, "refresh_token") : undefined;
      const candidateScopes = tokenBody && typeof tokenBody === "object" ? Reflect.get(tokenBody, "scope") : undefined;
      if (typeof candidateAccessToken !== "string" || candidateAccessToken.length < 1 || candidateAccessToken.length > 16_384) {
        throw new Error("Google token exchange failed");
      }
      if (
        candidateRefreshToken !== undefined &&
        (typeof candidateRefreshToken !== "string" || candidateRefreshToken.length > 16_384)
      ) {
        throw new Error("Google token exchange failed");
      }
      if (candidateScopes !== undefined && (typeof candidateScopes !== "string" || candidateScopes.length > 16_384)) {
        throw new Error("Google token exchange failed");
      }
      if (typeof candidateScopes === "string") {
        grantedScopes = candidateScopes.trim().split(/\s+/).filter(Boolean);
        if (!grantedScopes.length) throw new Error("Google token exchange failed");
      }
      accessToken = candidateAccessToken;
      refreshToken = typeof candidateRefreshToken === "string" && candidateRefreshToken.length > 0
        ? candidateRefreshToken
        : undefined;
    } catch {
      reject(req, res, 401, "Google connection could not be completed");
      return;
    }

    let googleIdentity: { sub: string; email: string } | undefined;
    try {
      const userInfoResponse = await fetcher(GOOGLE_USERINFO_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "error",
      });
      if (!userInfoResponse.ok) throw new Error("Google userinfo lookup failed");
      googleIdentity = googleUserIdentity(await userInfoResponse.json());
    } catch {
      reject(req, res, 401, "Google account email could not be verified");
      return;
    }
    if (!googleIdentity) {
      reject(req, res, 401, "Google account email could not be verified");
      return;
    }

    try {
      await googleStore.save({
        userId: transaction.userId,
        service: transaction.service,
        googleSub: googleIdentity.sub,
        email: googleIdentity.email,
        refreshToken,
        scopes: grantedScopes,
        now: now(),
      });
    } catch (error) {
      if (error instanceof MissingGoogleRefreshTokenError) {
        reject(req, res, 400, "Google did not return a refresh token. Reconnect and approve consent.");
        return;
      }
      reject(req, res, 500, "Google connection could not be saved");
      return;
    }

    res.statusCode = 303;
    const connectedLocation = new URL(uiLocation);
    connectedLocation.searchParams.set("connections", "connected");
    res.setHeader("location", connectedLocation.toString());
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://relay-bff.invalid");
    const method = req.method ?? "GET";
    logAuthRequest(req, res, method, url.pathname);
    if (url.pathname === "/auth/status" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { available: true, provider: "google", domain: "houseof434.com" });
    }

    if (url.pathname === "/auth/login" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      const { state, codeVerifier } = transactions.create();
      setOAuthStateCookie(res, state, oauthStateTtlMs, publicUrl);
      const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const callback = new URL("/auth/callback", bffOrigin);
      const authorize = new URL(supabaseAuthorizeUrl);
      authorize.searchParams.set("provider", "google");
      authorize.searchParams.set("redirect_to", callback.toString());
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      res.statusCode = 302;
      res.setHeader("location", authorize.toString());
      res.end();
      return;
    }

    if (url.pathname === "/auth/callback" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      const stateCookie = cookieValue(req, OAUTH_STATE_COOKIE_NAME);
      const callbackState = url.searchParams.getAll("state");
      const stateMatches = callbackState.length === 0 ||
        (callbackState.length === 1 && callbackState[0] === stateCookie);
      const transaction = stateCookie && stateMatches ? transactions.consume(stateCookie) : undefined;
      clearOAuthStateCookie(res, publicUrl);
      if (!transaction) {
        console.log(`[relay-bff] auth callback rejected: no transaction (state cookie ${stateCookie ? "present" : "absent"}, callback state params ${callbackState.length})`);
        reject(req, res, 400, "sign-in could not be completed");
        return;
      }
      const code = singleQueryValue(url, "code", OAUTH_CODE_PATTERN);
      if (url.searchParams.has("error") || !code) {
        console.log(`[relay-bff] auth callback rejected: provider error ${url.searchParams.get("error") ?? "(none)"}, code ${code ? "present" : "absent"}`);
        reject(req, res, 400, "sign-in could not be completed");
        return;
      }

      let accessToken: string;
      try {
        const exchanged = await fetcher(supabaseTokenUrl, {
          method: "POST",
          headers: { apikey: config.supabaseAnonKey, "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "pkce", auth_code: code, code_verifier: transaction.codeVerifier }),
          redirect: "error",
        });
        if (!exchanged.ok) throw new Error("PKCE exchange failed");
        const tokenResponse: unknown = await exchanged.json();
        const candidate = tokenResponse && typeof tokenResponse === "object"
          ? Reflect.get(tokenResponse, "access_token")
          : undefined;
        if (typeof candidate !== "string" || candidate.length > 16_384) throw new Error("PKCE exchange failed");
        accessToken = candidate;
      } catch {
        reject(req, res, 401, "sign-in could not be completed");
        return;
      }

      let identity: VerifiedSupabaseIdentity;
      try {
        identity = await verifySupabaseToken(accessToken);
      } catch {
        reject(req, res, 401, "sign-in could not be completed");
        return;
      }

      let relayToken: string;
      let relaySessionId: string;
      try {
        const bridgeResponse = await fetcher(new URL("/api/internal/portal-session", harnessBase), {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.relayBffCapability}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId: identity.subject,
            email: identity.email,
            scopes: ["client"],
            ...(identity.displayName ? { displayName: identity.displayName } : {}),
            ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
          }),
          redirect: "error",
        });
        if (!bridgeResponse.ok) throw new Error("Session issuance failed");
        const issued: unknown = await bridgeResponse.json();
        const candidate = issued && typeof issued === "object" ? Reflect.get(issued, "token") : undefined;
        const issuedSession = issued && typeof issued === "object" ? Reflect.get(issued, "session") : undefined;
        const sessionId = issuedSession && typeof issuedSession === "object" ? Reflect.get(issuedSession, "id") : undefined;
        if (
          typeof candidate !== "string" || !RELAY_SESSION_TOKEN_PATTERN.test(candidate) ||
          typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)
        ) {
          throw new Error("Session issuance failed");
        }
        relayToken = candidate;
        relaySessionId = sessionId;
      } catch {
        reject(req, res, 502, "sign-in could not be completed");
        return;
      }

      const previousId = cookieValue(req);
      const previousSession = previousId ? sessions.get(previousId) : undefined;
      if (previousId && previousSession) {
        try {
          const revokeResponse = await fetcher(new URL("/api/internal/portal-session/revoke", harnessBase), {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.relayBffCapability}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ sessionId: previousSession.relaySessionId }),
            redirect: "error",
          });
          if (!revokeResponse.ok) throw new Error("Session revocation failed");
        } catch {
          try {
            await fetcher(new URL("/api/internal/portal-session/revoke", harnessBase), {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.relayBffCapability}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ sessionId: relaySessionId }),
              redirect: "error",
            });
          } catch {
            // Preserve the old browser session and do not surface internal details.
          }
          reject(req, res, 502, "sign-in could not be completed");
          return;
        }
        sessions.delete(previousId);
      }
      const issuedSession = sessions.create(identity, relayToken, relaySessionId);
      setSessionCookie(res, issuedSession.id, sessionTtlMs, publicUrl);
      res.statusCode = 303;
      res.setHeader("location", uiLocation);
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }

    if (url.pathname === "/api/google/oauth/callback" && method === "GET") {
      await handleGoogleOAuthCallback(req, res, url);
      return;
    }

    if (url.pathname === "/api/google/calendar/events") {
      if (method !== "GET") {
        req.resume();
        res.setHeader("allow", "GET");
        json(res, 405, { error: "method not allowed" });
        return;
      }
      const sessionId = cookieValue(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        clearSessionCookie(res, publicUrl);
        reject(req, res, 401, "sign-in required");
        return;
      }
      if (!isAllowedRequestOrigin(req, publicUrl, config.uiPort)) {
        reject(req, res, 403, "forbidden");
        return;
      }
      req.resume();
      const bounds = calendarEventBounds(url);
      if (!bounds) {
        json(res, 400, { error: "timeMin and timeMax must be RFC3339 timestamps within a 366-day window." });
        return;
      }

      try {
        const configured = googleServiceConfigured("google-calendar", googleRegistry, config, publicUrl);
        const accounts = (await googleStore.list(session.subject))
          .filter((account) => account.service === "google-calendar");
        const events: GoogleCalendarEvent[] = [];
        const errors: Array<{ accountId: string; email: string; error: string }> = [];
        const seenEventIds = new Set<string>();
        let totalScanned = 0;

        for (const account of accounts) {
          if (!configured) {
            errors.push({ accountId: account.id, email: account.email, error: "Google Calendar is not configured." });
            continue;
          }
          if (totalScanned >= CALENDAR_EVENT_TOTAL_CAP) {
            errors.push({ accountId: account.id, email: account.email, error: CALENDAR_EVENT_LIMIT_ERROR });
            continue;
          }

          const accountEvents: GoogleCalendarEvent[] = [];
          let accountScanned = 0;
          let accountError: string | undefined;
          try {
            await googleApi.withClient(
              session.subject,
              "google-calendar",
              account.id,
              [GOOGLE_API_SCOPE_CATALOG["google-calendar"].read],
              async (client) => {
                let pageToken: string | undefined;
                const seenPageTokens = new Set<string>();
                let pageCount = 0;
                while (true) {
                  if (pageCount >= CALENDAR_EVENT_PAGE_CAP) {
                    accountError = CALENDAR_EVENT_LIMIT_ERROR;
                    break;
                  }
                  const remaining = CALENDAR_EVENT_TOTAL_CAP - totalScanned - accountScanned;
                  if (remaining <= 0) {
                    accountError = CALENDAR_EVENT_LIMIT_ERROR;
                    break;
                  }
                  pageCount += 1;
                  const response = await client.events.list({
                    calendarId: "primary",
                    timeMin: bounds.timeMin,
                    timeMax: bounds.timeMax,
                    singleEvents: true,
                    orderBy: "startTime",
                    maxResults: CALENDAR_EVENT_PAGE_SIZE,
                    ...(pageToken ? { pageToken } : {}),
                  });
                  const pageItems = response.data.items ?? [];
                  const includedItems = pageItems.slice(0, remaining);
                  for (const providerEvent of includedItems) {
                    accountScanned += 1;
                    const event = safeCalendarEvent(account, providerEvent);
                    if (event && !seenEventIds.has(event.id)) {
                      seenEventIds.add(event.id);
                      accountEvents.push(event);
                    }
                  }
                  if (pageItems.length > includedItems.length) {
                    accountError = CALENDAR_EVENT_LIMIT_ERROR;
                    break;
                  }

                  const nextPageToken = response.data.nextPageToken;
                  if (nextPageToken === undefined || nextPageToken === null || nextPageToken === "") break;
                  if (
                    typeof nextPageToken !== "string" || nextPageToken.length > 4096 ||
                    seenPageTokens.has(nextPageToken)
                  ) {
                    accountError = CALENDAR_EVENT_LOAD_ERROR;
                    break;
                  }
                  if (totalScanned + accountScanned >= CALENDAR_EVENT_TOTAL_CAP) {
                    accountError = CALENDAR_EVENT_LIMIT_ERROR;
                    break;
                  }
                  seenPageTokens.add(nextPageToken);
                  pageToken = nextPageToken;
                }
              },
            );
          } catch {
            accountError = CALENDAR_EVENT_LOAD_ERROR;
          }
          totalScanned += accountScanned;
          events.push(...accountEvents);
          if (accountError) errors.push({ accountId: account.id, email: account.email, error: accountError });
        }

        json(res, 200, {
          configured,
          connected: accounts.length > 0,
          events,
          errors,
        });
      } catch {
        json(res, 503, { error: "Google Calendar is temporarily unavailable." });
      }
      return;
    }

    if (url.pathname === "/api/google" || url.pathname.startsWith("/api/google/")) {
      const isList = url.pathname === "/api/google/connections" && method === "GET";
      const connectMatch = method === "POST"
        ? /^\/api\/google\/connections\/([^/]+)\/connect$/.exec(url.pathname)
        : null;
      const disconnectMatch = method === "DELETE"
        ? /^\/api\/google\/connections\/([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)
        : null;
      const connectService = connectMatch && isGoogleService(connectMatch[1]!) ? connectMatch[1] : undefined;
      const disconnectService = disconnectMatch && isGoogleService(disconnectMatch[1]!) ? disconnectMatch[1] : undefined;
      if (!isList && !connectService && !disconnectService) {
        reject(req, res, 404, "not found");
        return;
      }

      const sessionId = cookieValue(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        clearSessionCookie(res, publicUrl);
        reject(req, res, 401, "sign-in required");
        return;
      }
      if (!isAllowedRequestOrigin(req, publicUrl, config.uiPort)) {
        reject(req, res, 403, "forbidden");
        return;
      }
      req.resume();

      if (isList) {
        const services = googleServiceStatus(googleRegistry, config, publicUrl);
        const connections = await googleStore.list(session.subject);
        json(res, 200, {
          accounts: connections,
          configured: services.gmail || services["google-calendar"],
          services,
        });
        return;
      }

      if (connectService) {
        if (!isAllowedRequestOrigin(req, publicUrl, config.uiPort) || typeof req.headers.origin !== "string") {
          reject(req, res, 403, "forbidden");
          return;
        }
        const client = googleRegistry[connectService];
        const redirectUri = googleRedirectUri(config, publicUrl);
        if (!googleServiceConfigured(connectService, googleRegistry, config, publicUrl) || !client.clientId || !redirectUri) {
          json(res, 503, { error: "Google service is not configured" });
          return;
        }
        req.resume();
        const { state, codeVerifier } = googleTransactions.create({
          service: connectService,
          userId: session.subject,
          sessionId: sessionId!,
          clientId: client.clientId,
        });
        setGoogleOAuthStateCookie(res, connectService, state, config.relayBffCapability, oauthStateTtlMs, publicUrl);
        const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const authorize = new URL(GOOGLE_AUTHORIZE_URL);
        authorize.searchParams.set("client_id", client.clientId);
        authorize.searchParams.set("redirect_uri", redirectUri.toString());
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("scope", googleRegistry[connectService].scopes.join(" "));
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("access_type", "offline");
        authorize.searchParams.set("include_granted_scopes", "true");
        authorize.searchParams.set("prompt", "consent select_account");
        json(res, 200, { authorizationUrl: authorize.toString() });
        return;
      }

      if (disconnectService && disconnectMatch) {
        const accountId = disconnectMatch[2]!;
        const refreshToken = await googleStore.refreshTokenForAccount(session.subject, disconnectService, accountId);
        if (!refreshToken) {
          json(res, 404, { error: "Google connection not found" });
          return;
        }
        try {
          const revoked = await fetcher(GOOGLE_REVOKE_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken }),
            redirect: "error",
          });
          await revoked.arrayBuffer();
        } catch {
          // Local credentials are removed even when Google's revocation endpoint is unavailable.
        }
        const removal = await googleStore.deleteIfRefreshTokenMatches(
          session.subject,
          disconnectService,
          accountId,
          refreshToken,
        );
        if (removal === "not-found") {
          json(res, 404, { error: "Google connection not found" });
          return;
        }
        if (removal === "changed") {
          json(res, 409, { error: "Google connection changed during disconnect; retry disconnect" });
          return;
        }
        json(res, 200, { ok: true, disconnected: true });
        return;
      }
    }

    if (url.pathname === "/.well-known/relay/environment" && method === "GET") {
      await proxyRequest({
        req,
        res,
        target: new URL(url.pathname + url.search, harnessBase),
        fetcher,
      });
      return;
    }

    if (isInternalGmailPath(url.pathname)) {
      await handleInternalGmail(req, res, url.pathname, {
        googleApi,
        listAccounts: (userId) => googleStore.list(userId),
        capability: config.relayBffCapability,
        actorSecret: config.relayToolActorSecret,
        now,
      });
      return;
    }

    if (isInternalCalendarPath(url.pathname)) {
      await handleInternalCalendar(req, res, url.pathname, {
        googleApi,
        listAccounts: (userId) => googleStore.list(userId),
        capability: config.relayBffCapability,
        actorSecret: config.relayToolActorSecret,
        now,
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        reject(req, res, 404, "not found");
        return;
      }
      if (/^\/api\/+internal(?:\/|$)/i.test(decodedPath)) {
        reject(req, res, 404, "not found");
        return;
      }

      const sessionId = cookieValue(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        clearSessionCookie(res, publicUrl);
        reject(req, res, 401, "sign-in required");
        return;
      }

      const origin = req.headers.origin;
      if (origin !== undefined && (
        typeof origin !== "string" || !isAllowedUiOrigin(origin, publicUrl.origin, config.uiPort)
      )) {
        reject(req, res, 403, "forbidden");
        return;
      }

      if (url.pathname === "/api/auth/logout" && method === "POST") {
        req.resume();
        sessions.delete(sessionId!);
        clearSessionCookie(res, publicUrl);
        try {
          const response = await fetcher(new URL("/api/auth/logout", harnessBase), {
            method: "POST",
            headers: { authorization: `Bearer ${session.relayToken}`, "content-type": "application/json" },
            body: "{}",
            redirect: "manual",
          });
          await sendUpstreamResponse(req, res, response, harnessOrigin);
        } catch {
          if (!res.headersSent) json(res, 502, { error: "logout failed" });
        }
        return;
      }

      await proxyRequest({
        req,
        res,
        target: new URL(url.pathname + url.search, harnessBase),
        relayToken: session.relayToken,
        fetcher,
        origin: harnessOrigin,
      });
      return;
    }

    reject(req, res, 404, "not found");
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "request failed" });
      else if (!res.destroyed) res.destroy();
    });
  });
  return {
    server,
    googleApi,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}

export async function startRelayBff(env: NodeJS.ProcessEnv = process.env): Promise<RelayBffApplication> {
  const config = configFromEnvironment(env);
  const app = createRelayBff({ config });
  // Loopback by default. A compose deployment overrides this so the separate
  // Tool Layer container can reach the capability-gated /api/internal routes;
  // the port is never published, so only compose-network peers can dial it.
  const host = env.RELAY_BFF_HOST?.trim() || "127.0.0.1";
  await new Promise<void>((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(config.bffPort, host, () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  return app;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void startRelayBff().then((app) => {
    process.once("SIGINT", () => { void app.close().finally(() => { process.exitCode = 0; }); });
    process.once("SIGTERM", () => { void app.close().finally(() => { process.exitCode = 0; }); });
    console.log(`Relay BFF listening on http://${process.env.RELAY_BFF_HOST?.trim() || "127.0.0.1"}:${process.env.RELAY_BFF_PORT || DEFAULT_BFF_PORT}`);
  }).catch(() => {
    console.error("Relay BFF could not start; check required configuration and port availability.");
    process.exitCode = 1;
  });
}
