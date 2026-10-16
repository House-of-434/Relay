/** Shared TinyFish CLI plumbing for the tool layer's providers.
 *
 * Search and fetch both shell out to the same CLI with the same curated
 * environment and the same auth probe. Keeping that here means a credential or
 * environment change cannot drift between the two providers. */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes: number;
}

export type SpawnFn = (binary: string, args: string[], options: SpawnOptions) => Promise<SpawnResult>;

export const TINYFISH_PROBE_TIMEOUT_MS = 15_000;

export async function defaultSpawn(binary: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
    });
    return { exitCode: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      killed?: boolean;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    if (failure.killed) throw new Error(`TinyFish CLI timed out after ${options.timeoutMs}ms`);
    if (typeof failure.code === "number") {
      return {
        exitCode: failure.code,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
    throw new Error(
      `TinyFish CLI failed to start: ${typeof failure.message === "string" ? failure.message : "unknown error"}`,
    );
  }
}

export interface TinyFishCliOptions {
  binary?: string;
  path?: string;
  /** Operator-held key. Takes priority over any saved CLI config; never
   * model-supplied, never logged. */
  apiKey?: string;
  /** Passed through only when no API key is configured, so local saved
   * CLI config keeps working in dev. */
  home?: string;
  spawn?: SpawnFn;
}

/** One TinyFish CLI, shared by every provider. Holds the credential-handling
 * environment and the cached auth probe. */
export class TinyFishCli {
  readonly binary: string;
  readonly spawn: SpawnFn;
  private readonly path: string;
  private readonly apiKey: string | undefined;
  private readonly home: string | undefined;
  private available: boolean | null = null;

  constructor(options: TinyFishCliOptions = {}) {
    this.binary = options.binary ?? "tinyfish";
    this.path = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
    this.apiKey = options.apiKey;
    this.home = options.home;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  /** Curated CLI environment: PATH, key, telemetry off. Telemetry from a
   * server process is never the operator's choice to make per call. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = { PATH: this.path, TINYFISH_NO_TELEMETRY: "1" };
    if (this.apiKey) env.TINYFISH_API_KEY = this.apiKey;
    else if (this.home) env.HOME = this.home;
    return env;
  }

  /** Whether the CLI answers and holds credentials. Cached: presence cannot
   * change without a redeploy. */
  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const result = await this.spawn(this.binary, ["auth", "status"], {
        env: this.baseEnv(),
        timeoutMs: TINYFISH_PROBE_TIMEOUT_MS,
        maxBufferBytes: 65536,
      });
      if (result.exitCode !== 0) {
        this.available = false;
      } else {
        const status = JSON.parse(result.stdout) as { authenticated?: unknown };
        this.available = status.authenticated === true;
      }
    } catch {
      this.available = false;
    }
    return this.available;
  }
}
