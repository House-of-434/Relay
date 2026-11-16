import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { dataDirPath, readJsonFile, SerialQueue, writeJsonFileAtomic } from "./json-store.ts";

/** Per-user GitHub App user authorization.
 *
 * One record per Relay user. The GitHub App installation is metadata only;
 * the user token is the credential every GitHub action uses. Tokens are
 * AES-256-GCM encrypted with AAD bound to the owning user, following the
 * Notion connection store.
 *
 * No token is ever returned to an agent. The BFF resolves it from the
 * verified actor identity on every internal call. */

export interface GitHubUserConnection {
  userId: string;
  /** GitHub's numeric user id. Stable across login renames. */
  githubUserId: number;
  login: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  createdAt: string;
  updatedAt: string;
  /** Set after a 401 or a failed refresh. A reconnect replaces the record. */
  reauthRequired?: boolean;
}

interface EncryptedToken {
  keyVersion: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface StoredGitHubUserConnection extends GitHubUserConnection {
  accessToken: EncryptedToken;
  refreshToken?: EncryptedToken;
}

interface StoreFile {
  version: 1;
  connections: StoredGitHubUserConnection[];
}

const MAX_TOKEN_LENGTH = 16_384;
const MAX_LOGIN_LENGTH = 255;

export class GitHubUserTokenError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "GitHubUserTokenError";
    this.status = status;
  }
}

/** Same 32-byte key contract as the Google and Notion stores. */
export function parseGitHubTokenKey(value: string | undefined): Buffer {
  if (typeof value !== "string" || !value.trim()) throw new Error("GitHub token encryption key is unavailable");
  const trimmed = value.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
      throw new Error("GitHub token encryption key is invalid");
    }
  } else {
    throw new Error("GitHub token encryption key is invalid");
  }
  if (key.length !== 32) throw new Error("GitHub token encryption key is invalid");
  return key;
}

function identityAad(connection: Pick<GitHubUserConnection, "userId">): Buffer {
  return Buffer.from(`github-user\0${connection.userId}\0v1`);
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted token encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Invalid encrypted token encoding");
  return decoded;
}

function encryptToken(value: string, key: Buffer, connection: Pick<GitHubUserConnection, "userId">): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(identityAad(connection));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    keyVersion: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptToken(encrypted: EncryptedToken, key: Buffer, connection: Pick<GitHubUserConnection, "userId">): string {
  try {
    if (encrypted.keyVersion !== 1) throw new Error("Unsupported key version");
    const iv = decodeBase64Url(encrypted.iv);
    const authTag = decodeBase64Url(encrypted.authTag);
    const ciphertext = decodeBase64Url(encrypted.ciphertext);
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > MAX_TOKEN_LENGTH) {
      throw new Error("Invalid encrypted token");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(identityAad(connection));
    decipher.setAuthTag(authTag);
    const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!cleartext || cleartext.length > MAX_TOKEN_LENGTH) throw new Error("Invalid token");
    return cleartext;
  } catch {
    throw new Error("GitHub connection token authentication failed");
  }
}

function parseFile(raw: unknown): StoredGitHubUserConnection[] {
  const file = raw as StoreFile | undefined;
  if (!file || !Array.isArray(file.connections)) return [];
  return file.connections.filter((entry): entry is StoredGitHubUserConnection =>
    Boolean(entry) &&
    typeof entry.userId === "string" &&
    typeof entry.githubUserId === "number" &&
    Number.isSafeInteger(entry.githubUserId) &&
    typeof entry.login === "string" &&
    typeof entry.accessToken === "object" &&
    typeof entry.accessExpiresAt === "number" &&
    typeof entry.refreshExpiresAt === "number" &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string");
}

function publicConnection(entry: StoredGitHubUserConnection): GitHubUserConnection {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...rest } = entry;
  return rest;
}

export class GitHubUserConnectionStore {
  private readonly filePath: string;
  private readonly encryptionKey: string | undefined;
  private readonly clock: () => number;
  private readonly queue = new SerialQueue();

  constructor(options: { dataDir?: string; encryptionKey?: string; now?: () => number } = {}) {
    this.filePath = dataDirPath(options.dataDir ?? ".", "github-user-connections.json");
    this.encryptionKey = options.encryptionKey;
    this.clock = options.now ?? Date.now;
  }

  private async load(): Promise<StoredGitHubUserConnection[]> {
    return parseFile(await readJsonFile<StoreFile>(this.filePath));
  }

  async get(userId: string): Promise<GitHubUserConnection | undefined> {
    return this.queue.run(async () => {
      const entry = (await this.load()).find((candidate) => candidate.userId === userId);
      return entry ? publicConnection(entry) : undefined;
    });
  }

  /** The credential the BFF uses. Fails closed without a key. */
  async tokensFor(userId: string): Promise<{ accessToken: string; refreshToken?: string; connection: GitHubUserConnection } | undefined> {
    return this.queue.run(async () => {
      const key = parseGitHubTokenKey(this.encryptionKey);
      const entry = (await this.load()).find((candidate) => candidate.userId === userId);
      if (!entry) return undefined;
      return {
        accessToken: decryptToken(entry.accessToken, key, entry),
        ...(entry.refreshToken ? { refreshToken: decryptToken(entry.refreshToken, key, entry) } : {}),
        connection: publicConnection(entry),
      };
    });
  }

  async save(input: {
    userId: string;
    githubUserId: number;
    login: string;
    accessToken: string;
    refreshToken?: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  }): Promise<GitHubUserConnection> {
    return this.queue.run(async () => {
      const key = parseGitHubTokenKey(this.encryptionKey);
      if (!input.userId || !Number.isSafeInteger(input.githubUserId) || input.githubUserId <= 0) {
        throw new Error("Invalid GitHub user identity");
      }
      if (!input.login || input.login.length > MAX_LOGIN_LENGTH) throw new Error("Invalid GitHub login");
      if (!input.accessToken || Buffer.byteLength(input.accessToken, "utf8") > MAX_TOKEN_LENGTH) {
        throw new Error("Invalid GitHub access token");
      }
      if (input.refreshToken && Buffer.byteLength(input.refreshToken, "utf8") > MAX_TOKEN_LENGTH) {
        throw new Error("Invalid GitHub refresh token");
      }
      if (!Number.isFinite(input.accessExpiresAt) || !Number.isFinite(input.refreshExpiresAt)) {
        throw new Error("Invalid GitHub token expiry");
      }
      const connections = await this.load();
      const existing = connections.find((entry) => entry.userId === input.userId);
      const timestamp = new Date(this.clock()).toISOString();
      const base: GitHubUserConnection = {
        userId: input.userId,
        githubUserId: input.githubUserId,
        login: input.login,
        accessExpiresAt: input.accessExpiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const stored: StoredGitHubUserConnection = {
        ...base,
        accessToken: encryptToken(input.accessToken, key, base),
        ...(input.refreshToken ? { refreshToken: encryptToken(input.refreshToken, key, base) } : {}),
      };
      const next = connections.filter((entry) => entry.userId !== input.userId);
      next.push(stored);
      await writeJsonFileAtomic(this.filePath, { version: 1, connections: next } satisfies StoreFile);
      return publicConnection(stored);
    });
  }

  /** Replace only the tokens, preserving identity metadata. */
  async updateTokens(input: {
    userId: string;
    accessToken: string;
    refreshToken?: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  }): Promise<GitHubUserConnection | undefined> {
    return this.queue.run(async () => {
      const key = parseGitHubTokenKey(this.encryptionKey);
      const connections = await this.load();
      const index = connections.findIndex((entry) => entry.userId === input.userId);
      if (index < 0) return undefined;
      const current = connections[index]!;
      if (!input.accessToken || Buffer.byteLength(input.accessToken, "utf8") > MAX_TOKEN_LENGTH) {
        throw new Error("Invalid GitHub access token");
      }
      if (input.refreshToken && Buffer.byteLength(input.refreshToken, "utf8") > MAX_TOKEN_LENGTH) {
        throw new Error("Invalid GitHub refresh token");
      }
      const base: GitHubUserConnection = {
        ...publicConnection(current),
        accessExpiresAt: input.accessExpiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
        updatedAt: new Date(this.clock()).toISOString(),
        reauthRequired: undefined,
      };
      const stored: StoredGitHubUserConnection = {
        ...base,
        accessToken: encryptToken(input.accessToken, key, base),
        ...(input.refreshToken
          ? { refreshToken: encryptToken(input.refreshToken, key, base) }
          : current.refreshToken
            ? { refreshToken: current.refreshToken }
            : {}),
      };
      connections[index] = stored;
      await writeJsonFileAtomic(this.filePath, { version: 1, connections } satisfies StoreFile);
      return publicConnection(stored);
    });
  }

  async markReauthRequired(userId: string): Promise<void> {
    await this.queue.run(async () => {
      const connections = await this.load();
      const entry = connections.find((candidate) => candidate.userId === userId);
      if (!entry) return;
      entry.reauthRequired = true;
      entry.updatedAt = new Date(this.clock()).toISOString();
      await writeJsonFileAtomic(this.filePath, { version: 1, connections } satisfies StoreFile);
    });
  }

  async delete(userId: string): Promise<"deleted" | "not-found"> {
    return this.queue.run(async () => {
      const connections = await this.load();
      const remaining = connections.filter((entry) => entry.userId !== userId);
      if (remaining.length === connections.length) return "not-found";
      await writeJsonFileAtomic(this.filePath, { version: 1, connections: remaining } satisfies StoreFile);
      return "deleted";
    });
  }
}

/** Stable opaque id for logs and cache keys; never a credential. */
export function githubUserConnectionId(userId: string): string {
  return createHash("sha256").update(`github-user\0${userId}`).digest("hex");
}
