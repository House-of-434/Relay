/** Tool Layer environment contract. All reads happen at the same call sites
 * as before the clean-architecture split, so behavior is unchanged. */

import { homedir } from "node:os";
import { join } from "node:path";

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

export interface BladeConfig {
  /** Parent of per-user workspaces (`<root>/<userId>`). Stable XDG path by
   * default so saved logins survive restarts; override per deployment. */
  dataRoot: string;
  /** Bladebro binary: absolute path or a PATH name. */
  binary: string;
  /** Pinned Chrome for the daemon; Bladebro auto-detects when unset. */
  chromePath: string | undefined;
  /** Egress proxy for aggressively blocking sites; unset until chosen. */
  proxy: string | undefined;
  timezone: string | undefined;
  locale: string | undefined;
}

export interface SearchConfig {
  /** TinyFish CLI: absolute path or a PATH name. */
  binary: string;
  /** Operator-held key, preferred over saved CLI config. Never model input. */
  apiKey: string | undefined;
  /** Passed through only when no API key is configured (local saved CLI
   * config keeps working in dev). */
  home: string | undefined;
}

export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    binary: env.RELAY_SEARCH_BINARY ?? "tinyfish",
    apiKey: env.TINYFISH_API_KEY,
    home: env.HOME,
  };
}

export function bladeConfig(env: NodeJS.ProcessEnv = process.env): BladeConfig {
  return {
    dataRoot: env.RELAY_BLADE_ROOT ?? join(homedir(), ".local", "state", "relay-blade"),
    binary: env.RELAY_BLADE_BINARY ?? "bladebro",
    chromePath: env.CHROME_PATH,
    proxy: env.BLADE_PROXY,
    timezone: env.BLADE_TZ,
    locale: env.BLADE_LOCALE,
  };
}
