import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { dataDirPath, readJsonFile, SerialQueue, writeJsonFileAtomic } from "./json-store.ts";

/** Per-user Notion OAuth connections.
 *
 * One Relay user may connect several Notion workspaces; the same workspace may
 * be connected by several users, each with their own token. Uniqueness is
 * (userId, workspaceId): saving the same pair replaces the token, never
 * shares it. Access tokens are AES-256-GCM encrypted with AAD bound to the
 * owning user, mirroring the Google connection store.
 *
 * The BFF resolves the token from the verified actor identity on every
 * internal call. Tokens never cross into tool responses, logs, or config. */

export interface NotionConnection {
  /** Stable id derived from (userId, workspaceId); used by the UI/disconnect. */
  id: string;
  userId: string;
  workspaceId: string;
  workspaceName?: string;
  notionUserId?: string;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedAccessToken {
  keyVersion: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface StoredNotionConnection extends NotionConnection {
  accessToken: EncryptedAccessToken;
}

interface StoreFile {
  version: 1;
  connections: StoredNotionConnection[];
}

const MAX_TOKEN_LENGTH = 16_384;
const MAX_NAME_LENGTH = 255;

export function notionConnectionId(userId: string, workspaceId: string): string {
  return createHash("sha256").update(`notion\0${userId}\0${workspaceId}`).digest("hex");
}

/** Accepts the 32-byte key as 64-char hex or base64 (same contract as the
 * Google token key so one operator key can serve both stores). */
export function parseNotionTokenEncryptionKey(value: string | undefined): Buffer {
  if (typeof value !== "string" || !value.trim()) throw new Error("Notion token encryption key is unavailable");
  const trimmed = value.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
      throw new Error("Notion token encryption key is invalid");
    }
  } else {
    throw new Error("Notion token encryption key is invalid");
  }
  if (key.length !== 32) throw new Error("Notion token encryption key is invalid");
  return key;
}

function identityAad(connection: Pick<StoredNotionConnection, "userId" | "workspaceId" | "id">): Buffer {
  return Buffer.from(`${connection.userId}\0${connection.workspaceId}\0${connection.id}\0v1`);
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted token encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Invalid encrypted token encoding");
  return decoded;
}

function encryptAccessToken(
  accessToken: string,
  key: Buffer,
  connection: Pick<StoredNotionConnection, "userId" | "workspaceId" | "id">,
): EncryptedAccessToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(identityAad(connection));
  const ciphertext = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
  return {
    keyVersion: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptAccessToken(
  encrypted: EncryptedAccessToken,
  key: Buffer,
  connection: Pick<StoredNotionConnection, "userId" | "workspaceId" | "id">,
): string {
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
    if (!cleartext || cleartext.length > MAX_TOKEN_LENGTH) throw new Error("Invalid access token");
    return cleartext;
  } catch {
    throw new Error("Notion connection token authentication failed");
  }
}

function parseFile(raw: unknown): StoredNotionConnection[] {
  const file = raw as StoreFile | undefined;
  if (!file || !Array.isArray(file.connections)) return [];
  return file.connections.filter((entry): entry is StoredNotionConnection =>
    Boolean(entry) &&
    typeof entry.id === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.workspaceId === "string" &&
    typeof entry.accessToken === "object" &&
    typeof entry.createdAt === "string");
}

export class NotionConnectionStore {
  private readonly filePath: string;
  private readonly encryptionKey: string | undefined;
  private readonly queue = new SerialQueue();

  constructor(options: { dataDir?: string; encryptionKey?: string } = {}) {
    this.filePath = dataDirPath(options.dataDir ?? ".", "notion-connections.json");
    this.encryptionKey = options.encryptionKey;
  }

  private async load(): Promise<StoredNotionConnection[]> {
    return parseFile(await readJsonFile<StoreFile>(this.filePath));
  }

  /** Public metadata for the UI: never includes tokens. */
  async list(userId: string): Promise<NotionConnection[]> {
    return this.queue.run(async () => (await this.load())
      .filter((connection) => connection.userId === userId)
      .map(({ accessToken: _ignored, ...rest }) => rest));
  }

  async get(userId: string, id: string): Promise<NotionConnection | undefined> {
    return (await this.list(userId)).find((connection) => connection.id === id);
  }

  /** The token the BFF uses for internal calls. Fails closed without a key. */
  async accessTokenFor(userId: string, id: string): Promise<string | undefined> {
    return this.queue.run(async () => {
      const key = parseNotionTokenEncryptionKey(this.encryptionKey);
      const connection = (await this.load()).find((entry) => entry.userId === userId && entry.id === id);
      return connection ? decryptAccessToken(connection.accessToken, key, connection) : undefined;
    });
  }

  /** Most recent connection: what the Tool Layer state check and the default
   * internal calls use. */
  async find(userId: string): Promise<NotionConnection | undefined> {
    const mine = await this.list(userId);
    return mine[mine.length - 1];
  }

  async accessTokenForDefault(userId: string): Promise<string | undefined> {
    const connection = await this.find(userId);
    return connection ? this.accessTokenFor(userId, connection.id) : undefined;
  }

  /** Record (or refresh) a workspace connection for a user. */
  async save(input: {
    userId: string;
    workspaceId: string;
    workspaceName?: string;
    notionUserId?: string;
    accessToken: string;
    now?: number;
  }): Promise<NotionConnection> {
    return this.queue.run(async () => {
      const key = parseNotionTokenEncryptionKey(this.encryptionKey);
      if (!input.userId || !input.workspaceId || input.workspaceId.length > MAX_NAME_LENGTH) {
        throw new Error("Invalid Notion connection metadata");
      }
      if (!input.accessToken || Buffer.byteLength(input.accessToken, "utf8") > MAX_TOKEN_LENGTH) {
        throw new Error("Invalid Notion access token");
      }
      const workspaceName = input.workspaceName?.slice(0, MAX_NAME_LENGTH) || undefined;
      const notionUserId = input.notionUserId?.slice(0, MAX_NAME_LENGTH) || undefined;
      const id = notionConnectionId(input.userId, input.workspaceId);
      const connections = await this.load();
      const timestamp = new Date(input.now ?? Date.now()).toISOString();
      const existing = connections.find((entry) => entry.id === id);
      const base = {
        id,
        userId: input.userId,
        workspaceId: input.workspaceId,
        ...(workspaceName ? { workspaceName } : {}),
        ...(notionUserId ? { notionUserId } : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const stored: StoredNotionConnection = {
        ...base,
        accessToken: encryptAccessToken(input.accessToken, key, base),
      };
      const next = connections.filter((entry) => entry.id !== id);
      next.push(stored);
      await writeJsonFileAtomic(this.filePath, { version: 1, connections: next } satisfies StoreFile);
      return base;
    });
  }

  async delete(userId: string, id: string): Promise<"deleted" | "not-found"> {
    return this.queue.run(async () => {
      const connections = await this.load();
      const remaining = connections.filter((entry) => !(entry.userId === userId && entry.id === id));
      if (remaining.length === connections.length) return "not-found";
      await writeJsonFileAtomic(this.filePath, { version: 1, connections: remaining } satisfies StoreFile);
      return "deleted";
    });
  }
}
