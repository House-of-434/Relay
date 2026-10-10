/** Web-search provider contract plus the TinyFish adapter.
 *
 * Scout sees exactly one capability (`web_search`) returning URL, title,
 * and snippet. Which provider answers is Tool Layer infrastructure: the
 * model never learns provider names, credentials, or flags, so a future
 * self-hosted engine can replace TinyFish without changing Scout's tools.
 *
 * TinyFish shapes that do not survive the boundary: position ranks,
 * site_name labels, and provider-native query syntax. What crosses is
 * normalized {url, title, snippet} only.
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

/** Agent-facing result: the full contract. Providers may return richer
 * payloads; the adapter narrows to exactly these fields. */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

/** Provider-agnostic search controls. Providers implement what they
 * support and document what they ignore: TinyFish honors domain filters
 * and ignores freshness (recency is judged from result dates instead). */
export interface SearchOptions {
  limit?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  language?: string;
  location?: string;
  freshness?: "day" | "week" | "month";
}

export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface ProviderReport {
  /** What the run was configured to use. */
  requestedProvider: string;
  /** What actually executed (same when no substitution occurred). */
  actualProvider: string;
  /** Whether a fallback provider answered instead of the requested one. */
  fallbackUsed: boolean;
  /** Available, unavailable (probe failed / not installed / not authed), or failed (call error). */
  providerStatus: "available" | "unavailable" | "failed";
  /** Short, actionable diagnostic. Never includes credentials. */
  errorSummary?: string;
}

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
    if (failure.killed) throw new Error(`web search timed out after ${options.timeoutMs}ms`);
    if (typeof failure.code === "number") {
      return {
        exitCode: failure.code,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
    throw new Error(
      `web search failed to start: ${typeof failure.message === "string" ? failure.message : "unknown error"}`,
    );
  }
}

export interface TinyFishOptions {
  binary?: string;
  path?: string;
  /** Operator-held key. Takes priority over any saved CLI config; never
   * model-supplied, never logged. */
  apiKey?: string;
  /** Passed through only when no API key is configured, so local saved
   * CLI config keeps working in dev. */
  home?: string;
  timeoutMs?: number;
  spawn?: SpawnFn;
}

export const SEARCH_TIMEOUT_MS = 60_000;
export const SEARCH_MAX_BUFFER_BYTES = 1024 * 1024;
export const SEARCH_QUERY_MAX_LENGTH = 512;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 20;
const TINYFISH_PROBE_TIMEOUT_MS = 15_000;

interface TinyFishRow {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  /** Provider ranks, site labels, and anything else stay on this side of
   * the boundary: only url/title/snippet cross it. */
  [key: string]: unknown;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Narrow one provider row to the agent contract. Rows without a usable
 * URL are dropped: a result the agent cannot open is not a result. */
export function normalizeRow(row: TinyFishRow): SearchResult | null {
  if (!isHttpUrl(row.url)) return null;
  const title = typeof row.title === "string" && row.title.length > 0 ? row.title : (row.url as string);
  const snippet = typeof row.snippet === "string" ? row.snippet : "";
  return { url: row.url as string, title, snippet };
}

export function normalizeResults(value: unknown): SearchResult[] {
  if (!value || typeof value !== "object") throw new Error("web search returned an unreadable response");
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("web search returned an unreadable response");
  const narrowed: SearchResult[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const result = normalizeRow(row as TinyFishRow);
    if (result) narrowed.push(result);
  }
  return narrowed;
}

function cleanDomains(values: string[] | undefined, name: string): string | undefined {
  if (values === undefined) return undefined;
  const cleaned = values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
  if (cleaned.some((value) => /[\s,]/.test(value))) throw new Error(`${name} must be bare domain names`);
  return cleaned.length > 0 ? cleaned.join(",") : undefined;
}

export class TinyFishSearchProvider implements SearchProvider {
  private readonly binary: string;
  private readonly path: string;
  private readonly apiKey: string | undefined;
  private readonly home: string | undefined;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnFn;
  private available: boolean | null = null;
  private lastError: string | null = null;

  constructor(options: TinyFishOptions = {}) {
    this.binary = options.binary ?? "tinyfish";
    this.path = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
    this.apiKey = options.apiKey;
    this.home = options.home;
    this.timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  /** Whether the CLI answers and holds credentials. Cached: presence
   * cannot change without a redeploy. */
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

  /** Machine-readable provider report for preflight and run metadata.
   * Agent-facing tool errors stay provider-agnostic; this is the
   * observable record of requested vs actual provider. */
  async describe(): Promise<ProviderReport> {
    const up = await this.probe();
    if (!up) {
      return {
        requestedProvider: "tinyfish",
        actualProvider: "none",
        fallbackUsed: false,
        providerStatus: "unavailable",
        errorSummary: this.lastError ?? "tinyfish CLI unavailable or unauthenticated on this host",
      };
    }
    if (this.lastError) {
      return {
        requestedProvider: "tinyfish",
        actualProvider: "tinyfish",
        fallbackUsed: false,
        providerStatus: "failed",
        errorSummary: this.lastError,
      };
    }
    return {
      requestedProvider: "tinyfish",
      actualProvider: "tinyfish",
      fallbackUsed: false,
      providerStatus: "available",
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("web_search requires a non-empty query");
    }
    if (query.length > SEARCH_QUERY_MAX_LENGTH) {
      throw new Error(`web_search query must be under ${SEARCH_QUERY_MAX_LENGTH} characters`);
    }
    if (!(await this.probe())) {
      this.lastError = "tinyfish CLI unavailable or unauthenticated on this host";
      throw new Error("web search is unavailable on this host");
    }
    const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
    const args = ["search", "query", query];
    const include = cleanDomains(options.includeDomains, "include_domains");
    const exclude = cleanDomains(options.excludeDomains, "exclude_domains");
    if (include) args.push("--include-domains", include);
    if (exclude) args.push("--exclude-domains", exclude);
    if (options.language) args.push("--language", options.language);
    if (options.location) args.push("--location", options.location);
    // No freshness flag exists on this provider; recency is judged from
    // result dates downstream. Accepted (not rejected) so the interface
    // stays provider-agnostic.
    const result = await this.spawn(this.binary, args, {
      env: this.baseEnv(),
      timeoutMs: this.timeoutMs,
      maxBufferBytes: SEARCH_MAX_BUFFER_BYTES,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.length > 0 ? result.stderr.slice(0, 500) : "search command failed";
      this.lastError = detail;
      throw new Error(`web search failed: ${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      this.lastError = "provider returned a non-JSON response";
      throw new Error("web search returned an unreadable response");
    }
    try {
      const narrowed = normalizeResults(parsed).slice(0, limit);
      // Empty results are a successful provider answer ("no results"),
      // distinct from unavailable/failed. Callers must not conflate them.
      this.lastError = null;
      return narrowed;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "unreadable response";
      throw error;
    }
  }

  /** Curated CLI environment: PATH, key, telemetry off. Telemetry from a
   * server process is never the operator's choice to make per call. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = { PATH: this.path, TINYFISH_NO_TELEMETRY: "1" };
    if (this.apiKey) env.TINYFISH_API_KEY = this.apiKey;
    else if (this.home) env.HOME = this.home;
    return env;
  }
}
