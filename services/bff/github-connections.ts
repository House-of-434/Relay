import { createHash } from "node:crypto";

import { dataDirPath, readJsonFile, SerialQueue, writeJsonFileAtomic } from "./json-store.ts";

/** Per-user GitHub App installation metadata.
 *
 * No token is stored here. The user access token is the credential and lives
 * in github-user-connections.json. One installation may be visible to several
 * Relay users in the same organization; each user still has their own token
 * and their own repository permissions. */

export interface GitHubConnection {
  /** Stable id derived from the installation, used by the UI and disconnect. */
  id: string;
  userId: string;
  installationId: number;
  /** GitHub account or organization the app is installed on. */
  account: string;
  /** Permissions the installation granted, as reported by GitHub. */
  permissions: string[];
  repositorySelection?: string;
  createdAt: string;
}

interface StoreFile {
  version: 1;
  connections: GitHubConnection[];
}

export function githubConnectionId(installationId: number): string {
  return createHash("sha256").update(`github\0${installationId}`).digest("hex");
}

function parseFile(raw: unknown): GitHubConnection[] {
  const file = raw as StoreFile | undefined;
  if (!file || !Array.isArray(file.connections)) return [];
  return file.connections.filter((entry): entry is GitHubConnection =>
    Boolean(entry) &&
    typeof entry.id === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.installationId === "number" &&
    typeof entry.account === "string" &&
    Array.isArray(entry.permissions) &&
    typeof entry.createdAt === "string");
}

export class GitHubConnectionStore {
  private readonly filePath: string;
  private readonly queue = new SerialQueue();

  constructor(options: { dataDir?: string } = {}) {
    this.filePath = dataDirPath(options.dataDir ?? ".", "github-connections.json");
  }

  private async load(): Promise<GitHubConnection[]> {
    return parseFile(await readJsonFile<StoreFile>(this.filePath));
  }

  async list(userId: string): Promise<GitHubConnection[]> {
    return (await this.load()).filter((connection) => connection.userId === userId);
  }

  /** The connection the UI presents for a user: the most recent one. */
  async find(userId: string): Promise<GitHubConnection | undefined> {
    const mine = await this.list(userId);
    return mine[mine.length - 1];
  }

  async get(userId: string, id: string): Promise<GitHubConnection | undefined> {
    return (await this.list(userId)).find((connection) => connection.id === id);
  }

  /** Record an installation for a user. Replaces the same user's own record. */
  async save(connection: GitHubConnection): Promise<GitHubConnection> {
    return this.queue.run(async () => {
      const connections = await this.load();
      const next = connections.filter((entry) =>
        entry.installationId !== connection.installationId || entry.userId !== connection.userId);
      next.push(connection);
      await writeJsonFileAtomic(this.filePath, { version: 1, connections: next } satisfies StoreFile);
      return connection;
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
