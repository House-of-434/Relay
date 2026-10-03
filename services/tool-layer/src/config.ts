/** Tool Layer environment contract. All reads happen at the same call sites
 * as before the clean-architecture split, so behavior is unchanged. */

export function toolPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.RELAY_TOOL_PORT ?? "8787");
}

export function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("RELAY_TOOL_PORT must be a valid TCP port");
  }
}

export interface BffConfig {
  bffInternalUrl: string;
  capability: string | undefined;
}

export function bffConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  return {
    bffInternalUrl: env.RELAY_BFF_INTERNAL_URL ?? "http://127.0.0.1:8798",
    capability: env.RELAY_BFF_CAPABILITY,
  };
}
