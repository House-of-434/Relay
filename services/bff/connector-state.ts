import { dataDirPath, readJsonFile, SerialQueue, writeJsonFileAtomic } from "./json-store.ts";

/** The connectors this BFF tracks enablement for. Mirrors the Tool Layer's
 * ConnectorSource; the two services are separate packages, so the union is
 * declared here rather than imported. */
export type ConnectorSource = "arxiv" | "sec-edgar" | "github";

/** Per-user connector enablement.
 *
 * Enablement is deliberately separate from authentication, connection state,
 * and agent authorization: turning a connector on grants none of the others.
 * Defaults: arXiv on, SEC on, GitHub off (GitHub also requires a connected
 * installation before it can be used). Stored as non-secret JSON; no token or
 * credential ever lives here. */

export interface ConnectorEnablement {
  arxiv: boolean;
  sec: boolean;
  github: boolean;
}

export const CONNECTOR_DEFAULTS: ConnectorEnablement = Object.freeze({
  arxiv: true,
  sec: true,
  github: false,
});

interface StateFile {
  version: 1;
  users: Record<string, Partial<ConnectorEnablement>>;
}

function sourceKey(source: ConnectorSource): keyof ConnectorEnablement {
  return source === "sec-edgar" ? "sec" : source;
}

function normalize(value: Partial<ConnectorEnablement> | undefined): ConnectorEnablement {
  return {
    arxiv: typeof value?.arxiv === "boolean" ? value.arxiv : CONNECTOR_DEFAULTS.arxiv,
    sec: typeof value?.sec === "boolean" ? value.sec : CONNECTOR_DEFAULTS.sec,
    github: typeof value?.github === "boolean" ? value.github : CONNECTOR_DEFAULTS.github,
  };
}

export class ConnectorStateStore {
  private readonly filePath: string;
  private readonly queue = new SerialQueue();

  constructor(options: { dataDir?: string } = {}) {
    this.filePath = dataDirPath(options.dataDir ?? ".", "connector-state.json");
  }

  async get(userId: string): Promise<ConnectorEnablement> {
    const file = await readJsonFile<StateFile>(this.filePath);
    return normalize(file?.users?.[userId]);
  }

  /** Turn one connector on or off for one user. Returns the new state. */
  async set(userId: string, source: ConnectorSource, enabled: boolean): Promise<ConnectorEnablement> {
    return this.queue.run(async () => {
      let file = await readJsonFile<StateFile>(this.filePath);
      if (!file || typeof file !== "object" || Array.isArray(file)) file = { version: 1, users: {} };
      if (!file.users || typeof file.users !== "object" || Array.isArray(file.users)) file.users = {};
      const current = normalize(file.users[userId]);
      const next: ConnectorEnablement = { ...current, [sourceKey(source)]: enabled };
      file.users[userId] = next;
      await writeJsonFileAtomic(this.filePath, file);
      return next;
    });
  }
}
