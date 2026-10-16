/** Bounded JSON/HTTP client shared by the research connectors.
 *
 * Every connector makes outbound HTTP to a third party. This is the one place
 * that applies a timeout, a response-size cap, and retry-with-backoff so the
 * behavior is identical across arXiv, SEC, and GitHub instead of drifting per
 * provider. Secrets never appear in thrown messages. */

export class ConnectorHttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConnectorHttpError";
    this.status = status;
  }
}

export const CONNECTOR_TIMEOUT_MS = 15_000;
export const CONNECTOR_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = [500, 1_500, 4_000] as const;

export interface ConnectorFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  fetcher?: typeof fetch;
  /** Awaited between attempts — used by SEC to keep within its fair-access rate. */
  beforeRetry?: (attempt: number, waitMs: number) => Promise<void> | void;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number): number {
  const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)]!;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(base * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    throw new ConnectorHttpError("the upstream response is too large", response.status);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ConnectorHttpError("the upstream response is too large", response.status);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ConnectorHttpError("the upstream response is too large", response.status);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export interface ConnectorResponse {
  status: number;
  contentType: string;
  text: string;
}

/** Fetch a third-party URL once, with retries, and return the bounded body.
 * A non-2xx status is retried only when it is a 429/5xx, then thrown. */
export async function fetchWithRetry(url: string, options: ConnectorFetchOptions = {}): Promise<ConnectorResponse> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CONNECTOR_MAX_BYTES;
  const retries = options.retries ?? DEFAULT_RETRIES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const wait = backoffMs(attempt - 1);
      if (options.beforeRetry) await options.beforeRetry(attempt, wait);
      else await sleep(wait);
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt < retries) continue;
      throw new ConnectorHttpError(`the upstream service is unreachable: ${errorName(error)}`);
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < retries) {
        lastError = new ConnectorHttpError("the upstream service returned a retryable error", response.status);
        // Drain so the socket can be reused before the next attempt.
        await response.body?.cancel().catch(() => {});
        continue;
      }
      throw new ConnectorHttpError(`the upstream service refused the request (${response.status})`, response.status);
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text: await readBoundedText(response, maxBytes),
    };
  }
  throw lastError instanceof Error ? lastError : new ConnectorHttpError("the upstream request failed");
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "request timed out" : error.message.slice(0, 120);
  return "unknown error";
}

/** Fetch and parse JSON, mapping an unreadable body to a clear error. */
export async function fetchJson<T>(url: string, options: ConnectorFetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, options);
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ConnectorHttpError("the upstream service returned an unreadable response", response.status);
  }
}
