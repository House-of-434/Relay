import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GOOGLE_SERVICE_SCOPES = {
  gmail: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  "google-calendar": [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar.readonly",
    // Mercury may create, edit, and delete events on the owner's calendar.
    // Google treats calendar.events as strictly broader than the read scopes,
    // so it must be requested at consent time; an existing grant cannot be
    // widened without the owner reconnecting.
    "https://www.googleapis.com/auth/calendar.events",
  ],
} as const;

export type GoogleService = keyof typeof GOOGLE_SERVICE_SCOPES;

export interface GoogleOAuthClientSettings {
  clientId?: string;
  clientSecret?: string;
}

export interface GoogleServiceClient extends GoogleOAuthClientSettings {
  scopes: readonly string[];
}

export const GOOGLE_SERVICE_REGISTRY = {
  gmail: {
    clientIdEnvironmentVariable: "RELAY_CONN_GMAIL_CLIENT_ID",
    clientSecretEnvironmentVariable: "RELAY_CONN_GMAIL_CLIENT_SECRET",
    scopes: GOOGLE_SERVICE_SCOPES.gmail,
  },
  "google-calendar": {
    clientIdEnvironmentVariable: "RELAY_CONN_CALENDAR_CLIENT_ID",
    clientSecretEnvironmentVariable: "RELAY_CONN_CALENDAR_CLIENT_SECRET",
    scopes: GOOGLE_SERVICE_SCOPES["google-calendar"],
  },
} as const satisfies Record<GoogleService, {
  clientIdEnvironmentVariable: string;
  clientSecretEnvironmentVariable: string;
  scopes: readonly string[];
}>;

export function createGoogleServiceRegistry(
  clients: Partial<Record<GoogleService, GoogleOAuthClientSettings>> = {},
): Record<GoogleService, GoogleServiceClient> {
  return {
    gmail: { ...clients.gmail, scopes: GOOGLE_SERVICE_REGISTRY.gmail.scopes },
    "google-calendar": { ...clients["google-calendar"], scopes: GOOGLE_SERVICE_REGISTRY["google-calendar"].scopes },
  };
}

export interface GoogleConnectionMetadata {
  service: GoogleService;
  id: string;
  email: string;
}

interface EncryptedRefreshToken {
  keyVersion: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface StoredConnection extends GoogleConnectionMetadata {
  userId: string;
  googleSub: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  refreshToken: EncryptedRefreshToken;
}

interface StoreFile {
  version: 2;
  connections: StoredConnection[];
}

export interface GoogleConnectionCredential {
  googleSub: string;
  email: string;
  scopes: readonly string[];
  refreshToken: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REFRESH_TOKEN_LENGTH = 16_384;

export function googleConnectionsDataDir(value?: string): string {
  return value?.trim() || join(homedir(), ".openmausbot");
}

export function parseTokenEncryptionKey(value: string | undefined): Buffer {
  if (typeof value !== "string") throw new Error("Google token encryption key is unavailable");
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    key = Buffer.from(value, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new Error("Google token encryption key is invalid");
    }
  } else {
    throw new Error("Google token encryption key is invalid");
  }
  if (key.length !== 32) throw new Error("Google token encryption key is invalid");
  return key;
}

export function isGoogleService(value: string): value is GoogleService {
  return Object.hasOwn(GOOGLE_SERVICE_SCOPES, value);
}

function accountId(service: GoogleService, googleSub: string): string {
  return createHash("sha256").update(`${service}\0${googleSub}`).digest("base64url");
}

function identityAad(connection: Pick<StoredConnection, "userId" | "service" | "googleSub" | "id" | "email">): Buffer {
  return Buffer.from(`${connection.userId}\0${connection.service}\0${connection.googleSub}\0${connection.id}\0${connection.email}\0v1`);
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted token encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Invalid encrypted token encoding");
  return decoded;
}

function encryptRefreshToken(
  refreshToken: string,
  key: Buffer,
  connection: Pick<StoredConnection, "userId" | "service" | "googleSub" | "id" | "email">,
): EncryptedRefreshToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(identityAad(connection));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return {
    keyVersion: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptRefreshToken(
  encrypted: EncryptedRefreshToken,
  key: Buffer,
  connection: Pick<StoredConnection, "userId" | "service" | "googleSub" | "id" | "email">,
): string {
  try {
    if (encrypted.keyVersion !== 1) throw new Error("Unsupported key version");
    const iv = decodeBase64Url(encrypted.iv);
    const authTag = decodeBase64Url(encrypted.authTag);
    const ciphertext = decodeBase64Url(encrypted.ciphertext);
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new Error("Invalid encrypted token");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(identityAad(connection));
    decipher.setAuthTag(authTag);
    const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!cleartext || cleartext.length > MAX_REFRESH_TOKEN_LENGTH) throw new Error("Invalid refresh token");
    return cleartext;
  } catch {
    throw new Error("Google connection token authentication failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function normalizeGoogleScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 200) {
    throw new Error("Invalid Google granted scopes");
  }
  const normalized = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.trim() !== scope || !scope || scope.length > 2_048 || /\s/.test(scope)) {
      throw new Error("Invalid Google granted scopes");
    }
    normalized.add(scope);
  }
  if (!normalized.size) throw new Error("Invalid Google granted scopes");
  return [...normalized].sort();
}

function parseStoreFile(value: unknown): StoreFile {
  if (
    !isRecord(value) || !hasExactKeys(value, ["version", "connections"]) ||
    (value.version !== 1 && value.version !== 2) || !Array.isArray(value.connections)
  ) {
    throw new Error("Google connection store is corrupt");
  }
  const version = value.version;
  const identities = new Set<string>();
  const connections: StoredConnection[] = [];
  for (const candidate of value.connections) {
    const expectedConnectionKeys = version === 1
      ? ["service", "id", "email", "userId", "googleSub", "createdAt", "updatedAt", "refreshToken"]
      : ["service", "id", "email", "userId", "googleSub", "scopes", "createdAt", "updatedAt", "refreshToken"];
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, expectedConnectionKeys) ||
      !isRecord(candidate.refreshToken) ||
      !hasExactKeys(candidate.refreshToken, ["keyVersion", "iv", "authTag", "ciphertext"])
    ) throw new Error("Google connection store is corrupt");
    const { userId, service, id, email, googleSub, createdAt, updatedAt, refreshToken } = candidate;
    if (
      typeof userId !== "string" || !UUID_PATTERN.test(userId) || typeof service !== "string" || !isGoogleService(service) ||
      typeof googleSub !== "string" || !googleSub || googleSub.includes("\0") || googleSub.length > 255 ||
      typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id) || id !== accountId(service, googleSub) ||
      typeof email !== "string" || email.length > 320 || !EMAIL_PATTERN.test(email) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      (version === 2 && !Array.isArray(candidate.scopes)) ||
      refreshToken.keyVersion !== 1 || typeof refreshToken.iv !== "string" ||
      typeof refreshToken.authTag !== "string" || typeof refreshToken.ciphertext !== "string"
    ) throw new Error("Google connection store is corrupt");
    let scopes: string[];
    try {
      scopes = version === 1
        ? normalizeGoogleScopes(GOOGLE_SERVICE_SCOPES[service])
        : normalizeGoogleScopes(candidate.scopes as string[]);
      if (version === 2 && JSON.stringify(scopes) !== JSON.stringify(candidate.scopes)) {
        throw new Error("Scopes are not normalized");
      }
    } catch {
      throw new Error("Google connection store is corrupt");
    }
    const iv = decodeBase64Url(refreshToken.iv);
    const authTag = decodeBase64Url(refreshToken.authTag);
    const ciphertext = decodeBase64Url(refreshToken.ciphertext);
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new Error("Google connection store is corrupt");
    }
    const identity = `${userId}\0${service}\0${googleSub}`;
    if (identities.has(identity)) throw new Error("Google connection store is corrupt");
    identities.add(identity);
    connections.push({
      ...candidate,
      scopes,
    } as unknown as StoredConnection);
  }
  return { version: 2, connections };
}

export class MissingGoogleRefreshTokenError extends Error {
  constructor() {
    super("Google did not return a refresh token for this account");
    this.name = "MissingGoogleRefreshTokenError";
  }
}

export class GoogleConnectionStore {
  readonly filePath: string;
  private readonly encryptionKey: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { dataDir?: string; encryptionKey?: string }) {
    this.filePath = join(googleConnectionsDataDir(options.dataDir), "google-connections.json");
    this.encryptionKey = options.encryptionKey;
  }

  async list(userId: string): Promise<GoogleConnectionMetadata[]> {
    return this.exclusive(async () => {
      const file = await this.read();
      if (file.connections.length && this.encryptionKey?.trim()) {
        validateStoredTokens(file, parseTokenEncryptionKey(this.encryptionKey));
      }
      return file.connections
        .filter((connection) => connection.userId === userId)
        .map(({ service, id, email }) => ({ service, id, email }));
    });
  }

  async save(input: {
    userId: string;
    service: GoogleService;
    googleSub: string;
    email: string;
    refreshToken?: string;
    scopes?: readonly string[];
    now?: number;
  }): Promise<GoogleConnectionMetadata> {
    return this.exclusive(async () => {
      const key = parseTokenEncryptionKey(this.encryptionKey);
      const file = await this.read();
      validateStoredTokens(file, key);
      const existingIndex = file.connections.findIndex((connection) =>
        connection.userId === input.userId && connection.service === input.service && connection.googleSub === input.googleSub,
      );
      const existing = existingIndex < 0 ? undefined : file.connections[existingIndex];
      const refreshToken = input.refreshToken ?? (existing ? decryptRefreshToken(existing.refreshToken, key, existing) : undefined);
      const requestedScopes = input.scopes === undefined ? undefined : normalizeGoogleScopes(input.scopes);
      const scopes = requestedScopes === undefined
        ? existing?.scopes ?? normalizeGoogleScopes(GOOGLE_SERVICE_SCOPES[input.service])
        : existing && !input.refreshToken
          ? normalizeGoogleScopes([...existing.scopes, ...requestedScopes])
          : requestedScopes;
      if (
        typeof refreshToken !== "string" || !refreshToken ||
        Buffer.byteLength(refreshToken, "utf8") > MAX_REFRESH_TOKEN_LENGTH
      ) {
        throw new MissingGoogleRefreshTokenError();
      }
      if (
        !UUID_PATTERN.test(input.userId) || !input.googleSub || input.googleSub.includes("\0") || input.googleSub.length > 255 ||
        input.email.length > 320 || !EMAIL_PATTERN.test(input.email)
      ) {
        throw new Error("Invalid Google connection metadata");
      }
      const timestamp = new Date(input.now ?? Date.now()).toISOString();
      const base = {
        userId: input.userId,
        service: input.service,
        id: accountId(input.service, input.googleSub),
        googleSub: input.googleSub,
        email: input.email,
        scopes,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const connection: StoredConnection = {
        ...base,
        refreshToken: encryptRefreshToken(refreshToken, key, base),
      };
      if (existingIndex < 0) file.connections.push(connection);
      else file.connections[existingIndex] = connection;
      await this.write(file);
      return { service: connection.service, id: connection.id, email: connection.email };
    });
  }

  async refreshTokenForAccount(userId: string, service: GoogleService, id: string): Promise<string | undefined> {
    return this.exclusive(async () => {
      const key = parseTokenEncryptionKey(this.encryptionKey);
      const file = await this.read();
      validateStoredTokens(file, key);
      const connection = file.connections.find((candidate) =>
        candidate.userId === userId && candidate.service === service && candidate.id === id,
      );
      return connection ? decryptRefreshToken(connection.refreshToken, key, connection) : undefined;
    });
  }

  async internalCredentialForAccount(
    userId: string,
    service: GoogleService,
    id: string,
  ): Promise<GoogleConnectionCredential | undefined> {
    return this.exclusive(async () => {
      const key = parseTokenEncryptionKey(this.encryptionKey);
      const file = await this.read();
      validateStoredTokens(file, key);
      const connection = file.connections.find((candidate) =>
        candidate.userId === userId && candidate.service === service && candidate.id === id,
      );
      if (!connection) return undefined;
      return {
        googleSub: connection.googleSub,
        email: connection.email,
        scopes: [...connection.scopes],
        refreshToken: decryptRefreshToken(connection.refreshToken, key, connection),
      };
    });
  }

  async replaceRefreshTokenForAccount(input: {
    userId: string;
    service: GoogleService;
    id: string;
    googleSub: string;
    expectedRefreshToken: string;
    refreshToken: string;
  }): Promise<"updated" | "not-found" | "changed"> {
    return this.exclusive(async () => {
      if (
        !input.refreshToken || Buffer.byteLength(input.refreshToken, "utf8") > MAX_REFRESH_TOKEN_LENGTH ||
        !input.expectedRefreshToken || Buffer.byteLength(input.expectedRefreshToken, "utf8") > MAX_REFRESH_TOKEN_LENGTH
      ) throw new Error("Invalid Google refresh token");
      const key = parseTokenEncryptionKey(this.encryptionKey);
      const file = await this.read();
      validateStoredTokens(file, key);
      const connection = file.connections.find((candidate) =>
        candidate.userId === input.userId && candidate.service === input.service &&
        candidate.id === input.id && candidate.googleSub === input.googleSub,
      );
      if (!connection) return "not-found";
      const currentRefreshToken = decryptRefreshToken(connection.refreshToken, key, connection);
      if (currentRefreshToken === input.refreshToken) return "updated";
      if (currentRefreshToken !== input.expectedRefreshToken) return "changed";
      connection.refreshToken = encryptRefreshToken(input.refreshToken, key, connection);
      connection.updatedAt = new Date().toISOString();
      await this.write(file);
      return "updated";
    });
  }

  async deleteIfRefreshTokenMatches(
    userId: string,
    service: GoogleService,
    id: string,
    expectedRefreshToken: string,
  ): Promise<"deleted" | "not-found" | "changed"> {
    return this.exclusive(async () => {
      const key = parseTokenEncryptionKey(this.encryptionKey);
      const file = await this.read();
      validateStoredTokens(file, key);
      const index = file.connections.findIndex((connection) =>
        connection.userId === userId && connection.service === service && connection.id === id,
      );
      if (index < 0) return "not-found";
      if (decryptRefreshToken(file.connections[index]!.refreshToken, key, file.connections[index]!) !== expectedRefreshToken) {
        return "changed";
      }
      file.connections.splice(index, 1);
      await this.write(file);
      return "deleted";
    });
  }

  private async read(): Promise<StoreFile> {
    let contents: string;
    try {
      await this.secureDirectory(false);
      const fileStat = await lstat(this.filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Invalid Google connection store file");
      await chmod(this.filePath, 0o600);
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { version: 2, connections: [] };
      throw new Error("Google connection store is unavailable");
    }
    try {
      return parseStoreFile(JSON.parse(contents) as unknown);
    } catch {
      throw new Error("Google connection store is corrupt");
    }
  }

  private async write(file: StoreFile): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.secureDirectory(true);
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(file), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error("Google connection store could not be written");
    }
  }

  private async secureDirectory(create: boolean): Promise<void> {
    const directory = dirname(this.filePath);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Invalid Google connection store directory");
    }
    await chmod(directory, 0o700);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateStoredTokens(file: StoreFile, key: Buffer): void {
  for (const connection of file.connections) {
    decryptRefreshToken(connection.refreshToken, key, connection);
  }
}
