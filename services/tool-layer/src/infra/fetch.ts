/** Web-fetch provider contract plus the TinyFish adapter.
 *
 * Scout sees one capability (`web_fetch`) returning clean page text. Which
 * provider answers is Tool Layer infrastructure; the model never learns
 * provider names, credentials, or flags. This is the default path for ordinary
 * page reads, including JavaScript-rendered pages; the browser tools remain
 * the escalation path for pages that need interaction, persistent state, or
 * structured extraction. Provider-native fields that do not survive the
 * boundary: latency, redirect chains, extraction diagnostics. */

import { TinyFishCli, type SpawnFn } from "./tinyfish.js";
import { assertHttpUrl } from "./bladebro.js";
import { isHttpUrl } from "./search.js";

export type FetchFormat = "markdown" | "html" | "json";

export interface FetchResult {
  url: string;
  title: string;
  format: FetchFormat;
  text: string;
  links?: string[];
  truncated: boolean;
}

export interface FetchOptions {
  format?: FetchFormat;
  links?: boolean;
}

export interface FetchProvider {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface TinyFishFetchOptions {
  binary?: string;
  path?: string;
  /** Operator-held key. Takes priority over any saved CLI config; never
   * model-supplied, never logged. */
  apiKey?: string;
  home?: string;
  timeoutMs?: number;
  spawn?: SpawnFn;
}

export const FETCH_TIMEOUT_MS = 60_000;
export const FETCH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const FETCH_MAX_CHARS = 40_000;
export const FETCH_URL_MAX_LENGTH = 2048;
export const FETCH_MAX_LINKS = 50;

interface TinyFishFetchRow {
  url?: unknown;
  final_url?: unknown;
  title?: unknown;
  format?: unknown;
  text?: unknown;
  links?: unknown;
}

function isFormat(value: unknown): value is FetchFormat {
  return value === "markdown" || value === "html" || value === "json";
}

/** Render the provider's `text` field: a string for markdown/html, a document
 * tree (object) for json. Anything else is unusable. */
function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

/** Narrow one provider result to the agent contract. A page without content
 * throws: an empty body that looks like a successful read is worse than an
 * honest failure. */
export function normalizeFetchResult(value: unknown, requestedUrl: string, format: FetchFormat): FetchResult {
  if (!value || typeof value !== "object") throw new Error("web fetch returned an unreadable response");
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) {
    const errors = (value as { errors?: unknown }).errors;
    const detail = Array.isArray(errors) && errors[0] !== null && typeof errors[0] === "object"
      ? (errors[0] as { error?: unknown }).error
      : undefined;
    throw new Error(typeof detail === "string" && detail.length > 0
      ? `web fetch failed: ${detail.slice(0, 300)}`
      : "web fetch returned no content");
  }
  const row = results[0] as TinyFishFetchRow;
  const url = isHttpUrl(row.final_url) ? (row.final_url as string) : isHttpUrl(row.url) ? (row.url as string) : requestedUrl;
  const title = typeof row.title === "string" && row.title.length > 0 ? row.title : url;
  const rawText = toText(row.text) ?? "";
  if (rawText.trim().length === 0) throw new Error("web fetch returned no content");
  const truncated = rawText.length > FETCH_MAX_CHARS;
  const links = Array.isArray(row.links)
    ? row.links.filter((link): link is string => isHttpUrl(link)).slice(0, FETCH_MAX_LINKS)
    : undefined;
  return {
    url,
    title,
    format: isFormat(row.format) ? row.format : format,
    text: truncated ? rawText.slice(0, FETCH_MAX_CHARS) : rawText,
    links: links && links.length > 0 ? links : undefined,
    truncated,
  };
}

export class TinyFishFetchProvider implements FetchProvider {
  private readonly cli: TinyFishCli;
  private readonly timeoutMs: number;
  private lastError: string | null = null;

  constructor(options: TinyFishFetchOptions = {}) {
    this.cli = new TinyFishCli({
      binary: options.binary,
      path: options.path,
      apiKey: options.apiKey,
      home: options.home,
      spawn: options.spawn,
    });
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  async probe(): Promise<boolean> {
    return this.cli.probe();
  }

  /** Curated CLI environment; shared with the search provider. */
  baseEnv(): Record<string, string> {
    return this.cli.baseEnv();
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    if (!isHttpUrl(url)) throw new Error("web_fetch requires an http(s) URL");
    if (url.length > FETCH_URL_MAX_LENGTH) {
      throw new Error(`web_fetch URL must be under ${FETCH_URL_MAX_LENGTH} characters`);
    }
    assertHttpUrl(url);
    if (!(await this.probe())) {
      this.lastError = "tinyfish CLI unavailable or unauthenticated on this host";
      throw new Error("web fetch is unavailable on this host");
    }
    const format: FetchFormat = options.format ?? "markdown";
    const args = ["fetch", "content", "get", "--format", format];
    if (options.links) args.push("--links");
    args.push(url);
    const result = await this.cli.spawn(this.cli.binary, args, {
      env: this.cli.baseEnv(),
      timeoutMs: this.timeoutMs,
      maxBufferBytes: FETCH_MAX_BUFFER_BYTES,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.length > 0 ? result.stderr.slice(0, 500) : "fetch command failed";
      this.lastError = detail;
      throw new Error(`web fetch failed: ${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      this.lastError = "provider returned a non-JSON response";
      throw new Error("web fetch returned an unreadable response");
    }
    try {
      const normalized = normalizeFetchResult(parsed, url, format);
      this.lastError = null;
      return normalized;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "unreadable response";
      throw error;
    }
  }
}
