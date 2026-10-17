/** Per-actor GitHub connection state, resolved from the BFF.
 *
 * GitHub is the one research connector behind a per-user connection, so its
 * connected state can only be read server-side from a verified actor. The Tool
 * Layer asks the BFF once per MCP request and offers GitHub tools only when an
 * installation is linked; the BFF refuses the call again. If the BFF cannot be
 * reached, GitHub is treated as not connected: fail closed. arXiv and SEC are
 * public built-ins with no per-user state, so they are decided in-process and
 * are unaffected by this call. */

export interface ConnectorState {
  github: { connected: boolean };
  notion: { connected: boolean };
}

export const NO_CONNECTORS: ConnectorState = {
  github: { connected: false },
  notion: { connected: false },
};

export interface ConnectorStateClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

export class ConnectorStateClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: ConnectorStateClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Returns the actor's connection state, or NO_CONNECTORS when it cannot be
   * established. Never throws: a failure must not take down relay_read/write. */
  async state(actorAssertion: string): Promise<ConnectorState> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) return NO_CONNECTORS;
    try {
      const response = await this.fetcher(new URL("/api/internal/connectors/state", this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok) return NO_CONNECTORS;
      return parseConnectorState(await response.json());
    } catch {
      console.error("[relay-tools] GitHub connection state unavailable; offering no GitHub tools this request");
      return NO_CONNECTORS;
    }
  }
}

function bool(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[key] === true);
}

export function parseConnectorState(raw: unknown): ConnectorState {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    github: { connected: bool(value.github, "connected") },
    notion: { connected: bool(value.notion, "connected") },
  };
}
