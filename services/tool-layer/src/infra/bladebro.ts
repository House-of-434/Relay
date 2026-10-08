/** Bladebro process adapter: runs the Bladebro CLI on behalf of one user's
 * workspace. Implements the policy in `./browser-lifecycle.ts`:
 *
 * - one daemon per user, multiplexed by data root: Bladebro keeps a daemon
 *   per BLADE_HOME behind a socket in that root, so two users can never
 *   share a daemon by construction (spike-verified with concurrent homes).
 * - the environment is built from scratch per call: only BLADE_ALLOWED_ENV
 *   keys, never ambient process env and never model input.
 * - the lane stays unset (Bladebro's default is the isolated agent
 *   browser); `rb`, real-browser, attach, and --host/--port are never used.
 * - every call is bounded (action timeout, output cap, result budget) and
 *   oversized results spill to the user's own artifacts directory.
 * - same-user calls run fully parallel: first-spawn races are serialized
 *   by Bladebro's native data-root lock, not here.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  BLADE_ACTION_TIMEOUT_MS,
  BLADE_ALLOWED_ENV,
  BLADE_IDLE_RECLAIM_MS,
  MAX_BLADE_DAEMONS,
  artifactsDirFor,
  assertIsolatedDaemonConfig,
} from "./browser-lifecycle.js";
import { canonicalDataRoot, canonicalUserId, workspaceRootFor } from "./workspace-identity.js";

const execFileAsync = promisify(execFileCallback);

/** Bounded page text returned to the model. Matches the harness's
 * long-standing browser result budget. */
export const BROWSER_RESULT_BUDGET = 32_000;
/** Hard cap on one bladebro response body. */
export const BLADE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const BLADE_URL_MAX_LENGTH = 2048;
const BLADE_PROBE_TIMEOUT_MS = 15_000;
const BLADE_ARTIFACT_PAGE_LIMIT = 8_000;

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

async function defaultSpawn(binary: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
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
    if (failure.killed) throw new Error(`research browser timed out after ${options.timeoutMs}ms`);
    if (typeof failure.code === "number") {
      return {
        exitCode: failure.code,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
    throw new Error(
      `research browser failed to start: ${typeof failure.message === "string" ? failure.message : "unknown error"}`,
    );
  }
}

export interface BladePoolOptions {
  dataRoot: string;
  binary?: string;
  path?: string;
  chromePath?: string;
  proxy?: string;
  timezone?: string;
  locale?: string;
  idleReclaimMs?: number;
  maxDaemons?: number;
  spawn?: SpawnFn;
  now?: () => number;
}

export interface BrowserText {
  text: string;
  artifact?: string;
}

export type ReadMode = "content" | "outline" | "find" | "artifact";
export type ExtractKind = "auto" | "links" | "forms";

/** Argv elements the adapter will never pass: remote endpoints, the
 * real-browser lane, and surfaces we do not use (direct MCP mount,
 * manual daemon control). */
const FORBIDDEN_ARGS = new Set(["--host", "--port", "rb", "mcp", "daemon"]);

export function assertHttpUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0 || url.length > BLADE_URL_MAX_LENGTH) {
    throw new Error("browser url must be a short http(s) string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("browser url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser url must be http(s)");
  }
  if (parsed.username || parsed.password) throw new Error("browser url must not contain credentials");
  return parsed.toString();
}

export class BladeBrowserPool {
  private readonly dataRoot: string;
  private readonly binary: string;
  private readonly path: string;
  private readonly chromePath: string | undefined;
  private readonly proxy: string | undefined;
  private readonly timezone: string | undefined;
  private readonly locale: string | undefined;
  private readonly idleReclaimMs: number;
  private readonly maxDaemons: number;
  private readonly spawn: SpawnFn;
  private readonly now: () => number;
  private readonly workspaces = new Map<string, { lastUsed: number }>();
  private available: boolean | null = null;

  constructor(options: BladePoolOptions) {
    assertIsolatedDaemonConfig({});
    this.dataRoot = canonicalDataRoot(options.dataRoot);
    this.binary = options.binary ?? "bladebro";
    this.path = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
    this.chromePath = options.chromePath;
    this.proxy = options.proxy;
    this.timezone = options.timezone;
    this.locale = options.locale;
    this.idleReclaimMs = options.idleReclaimMs ?? BLADE_IDLE_RECLAIM_MS;
    this.maxDaemons = options.maxDaemons ?? MAX_BLADE_DAEMONS;
    this.spawn = options.spawn ?? defaultSpawn;
    this.now = options.now ?? Date.now;
  }

  /** Workspace root (BLADE_HOME) for a user. Throws for unauthenticated or
   * hostile identities — there is no workspace without a UUID actor. */
  workspaceFor(userId: unknown): string {
    return workspaceRootFor(this.dataRoot, userId);
  }

  /** Whether the binary answers. Cached: presence cannot change without a
   * redeploy, and every call site already handles failure clearly. */
  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const result = await this.spawn(
        this.binary,
        ["--version"],
        { env: { PATH: this.path }, timeoutMs: BLADE_PROBE_TIMEOUT_MS, maxBufferBytes: 65536 },
      );
      this.available = result.exitCode === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Curated daemon environment, built from scratch: only allowlisted keys,
   * never ambient env, never model input. HOME is contained to the
   * workspace so Chrome's disk writes cannot escape it either. */
  buildEnv(workspaceRoot: string, fresh: boolean): Record<string, string> {
    const env: Record<string, string> = {
      PATH: this.path,
      HOME: workspaceRoot,
      BLADE_HOME: workspaceRoot,
      BLADE_NO_UPDATE_CHECK: "1",
      BLADE_CONSENT: "reject",
      BLADE_IDLE_TIMEOUT: String(Math.max(60, Math.floor(this.idleReclaimMs / 1000))),
      BLADE_CMD_TIMEOUT: "300",
    };
    if (fresh) env.BLADE_FRESH = "1";
    if (this.chromePath) env.CHROME_PATH = this.chromePath;
    if (this.proxy) env.BLADE_PROXY = this.proxy;
    if (this.timezone) env.BLADE_TZ = this.timezone;
    if (this.locale) env.BLADE_LOCALE = this.locale;
    assertNoForbiddenEnv(env);
    return env;
  }

  async open(userId: unknown, url: string, fresh = false): Promise<BrowserText> {
    const target = assertHttpUrl(url);
    const text = await this.run(userId, ["nav", target], fresh);
    return this.boundResult(userId, "open", text);
  }

  async read(
    userId: unknown,
    mode: ReadMode,
    query?: string,
    artifact?: string,
    offset?: number,
    limit?: number,
  ): Promise<BrowserText> {
    if (mode === "artifact") {
      if (typeof artifact !== "string" || artifact.length === 0) {
        throw new Error('browser_read with mode "artifact" requires an artifact path');
      }
      return { text: await this.readArtifact(userId, artifact, offset, limit) };
    }
    const args =
      mode === "content"
        ? ["see", "content", "--budget", String(BROWSER_RESULT_BUDGET)]
        : mode === "outline"
          ? ["see", "outline"]
          : ["see", "--find", requireQuery(query)];
    const text = await this.run(userId, args, false);
    return this.boundResult(userId, "read", text);
  }

  async extract(userId: unknown, url: string | null, kind: ExtractKind = "auto"): Promise<BrowserText> {
    const args =
      url === null ? ["see", "extract", kind] : ["see", "extract", kind, assertHttpUrl(url)];
    const text = await this.run(userId, args, false);
    return this.boundResult(userId, "extract", text);
  }

  /** Page one of our own spilled artifacts. Paths are workspace-relative;
   * anything absolute, empty, or escaping the artifacts dir is refused. */
  async readArtifact(userId: unknown, artifact: string, offset?: number, limit?: number): Promise<string> {
    const root = this.workspaceFor(userId);
    if (typeof artifact !== "string" || artifact.length === 0 || isAbsolute(artifact)) {
      throw new Error("artifact path must be a workspace-relative name");
    }
    const dir = artifactsDirFor(root);
    const resolved = resolve(dir, artifact);
    const rel = relative(dir, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("artifact path escapes the workspace");
    }
    const start = offset ?? 0;
    const page = Math.min(limit ?? BLADE_ARTIFACT_PAGE_LIMIT, BROWSER_RESULT_BUDGET);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(page) || page <= 0) {
      throw new Error("artifact offset/limit must be non-negative integers");
    }
    const full = await readFile(resolved, "utf8").catch(() => {
      throw new Error("artifact not found in this workspace");
    });
    return full.slice(start, start + page);
  }

  /** Best-effort graceful shutdown for reclaim: flushes logins and
   * learned knowledge, idempotent when nothing runs. */
  async stopWorkspace(userId: string): Promise<void> {
    let root: string;
    try {
      root = this.workspaceFor(userId);
    } catch {
      return;
    }
    await this.spawn(this.binary, ["stop"], {
      env: this.buildEnv(root, false),
      timeoutMs: BLADE_PROBE_TIMEOUT_MS,
      maxBufferBytes: 65536,
    }).catch(() => {});
    this.workspaces.delete(userId);
  }

  private trackWorkspace(userId: unknown): { id: string; root: string } {
    const id = canonicalUserId(userId);
    const root = this.workspaceFor(id);
    if (!this.workspaces.has(id) && this.workspaces.size >= this.maxDaemons) {
      throw new Error("research browser is at capacity; try again when fewer workspaces are active");
    }
    this.workspaces.set(id, { lastUsed: this.now() });
    return { id, root };
  }

  private async sweepIdle(currentUserId: string): Promise<void> {
    for (const [id, state] of this.workspaces) {
      if (id === currentUserId) continue;
      if (this.now() - state.lastUsed > this.idleReclaimMs) {
        await this.stopWorkspace(id);
      }
    }
  }

  private async run(userId: unknown, args: string[], fresh: boolean): Promise<string> {
    assertSafeArgs(args);
    if (!(await this.probe())) {
      throw new Error("research browser is unavailable on this host");
    }
    const tracked = this.trackWorkspace(userId);
    await this.sweepIdle(tracked.id);
    const result = await this.spawn(this.binary, [...args, "--json"], {
      env: this.buildEnv(tracked.root, fresh),
      timeoutMs: BLADE_ACTION_TIMEOUT_MS,
      maxBufferBytes: BLADE_MAX_BUFFER_BYTES,
    });
    if (result.exitCode === 0) return parseBladeOutput(result.stdout);
    // Exit 1 is a page-level failure (blocked, challenge, bad selector):
    // the text carries page state for recovery, so it is returned as the
    // error, bounded like any other result.
    if (result.exitCode === 1) {
      throw new Error(boundText(extractErrorText(result), BROWSER_RESULT_BUDGET));
    }
    if (result.exitCode === 2) {
      throw new Error(`research browser misused: ${result.stderr.slice(0, 500)}`);
    }
    throw new Error(`research browser exited ${String(result.exitCode)}`);
  }

  private async boundResult(userId: unknown, tool: string, text: string): Promise<BrowserText> {
    if (text.length <= BROWSER_RESULT_BUDGET) return { text };
    const root = this.workspaceFor(userId);
    const dir = artifactsDirFor(root);
    await mkdir(dir, { recursive: true });
    const name = `${this.now()}-${tool}.md`;
    await writeFile(join(dir, name), text, "utf8");
    const kept = text.slice(0, BROWSER_RESULT_BUDGET);
    return {
      text: `${kept}\n\n…(${text.length - BROWSER_RESULT_BUDGET} more chars in artifact ${name}; use browser_read with mode "artifact" to page it.)`,
      artifact: name,
    };
  }
}

function requireQuery(query: string | undefined): string {
  if (typeof query !== "string" || query.length === 0 || query.length > 512) {
    throw new Error('browser_read with mode "find" requires a short query');
  }
  return query;
}

export function assertSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_ARGS.has(arg)) throw new Error(`forbidden bladebro argument: ${arg}`);
  }
}

function assertNoForbiddenEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!(BLADE_ALLOWED_ENV as readonly string[]).includes(key) && key !== "PATH" && key !== "HOME") {
      throw new Error(`refusing to forward unlisted environment variable: ${key}`);
    }
  }
}

function parseBladeOutput(stdout: string): string {
  let json: { ok?: unknown; text?: unknown };
  try {
    json = JSON.parse(stdout) as { ok?: unknown; text?: unknown };
  } catch {
    throw new Error("research browser returned an unreadable response");
  }
  if (json.ok !== true || typeof json.text !== "string") {
    throw new Error("research browser reported a failure with no readable output");
  }
  return json.text;
}

function extractErrorText(result: SpawnResult): string {
  try {
    const json = JSON.parse(result.stdout) as { text?: unknown };
    if (typeof json.text === "string" && json.text.length > 0) return json.text;
  } catch {
    // fall through to stderr
  }
  return result.stderr.length > 0 ? result.stderr : "browser action failed with no details";
}

function boundText(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}\n\n…(truncated)`;
}
