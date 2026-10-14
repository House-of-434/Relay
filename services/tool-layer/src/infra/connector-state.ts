/** Per-actor connector enablement, resolved from the BFF.
 *
 * Enablement is a per-user setting, so it can only be read server-side from a
 * verified actor. The Tool Layer asks the BFF once per MCP request and uses the
 * answer to decide which connector tools to offer. A disabled connector is
 * therefore never registered, and the BFF refuses it again on the call. If the
 * BFF cannot be reached, every connector is treated as disabled: fail closed,
 * never expose a tool whose policy could not be checked. */

export interface ConnectorState {
  arxiv: { enabled: boolean };
  sec: { enabled: boolean };
  github: { enabled: boolean; connected: boolean };
}

export const NO_CONNECTORS: ConnectorState = {
  arxiv: { enabled: false },
  sec: { enabled: false },
  github: { enabled: false, connected: false },
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

  /** Returns the actor's enablement, or NO_CONNECTORS when it cannot be
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
      console.error("[relay-tools] connector state unavailable; exposing no connectors this request");
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
    arxiv: { enabled: bool(value.arxiv, "enabled") },
    sec: { enabled: bool(value.sec, "enabled") },
    github: {
      enabled: bool(value.github, "enabled"),
      connected: bool(value.github, "connected"),
    },
  };
}
