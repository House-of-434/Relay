import { createSign } from "node:crypto";

/** GitHub App gateway.
 *
 * Mints short-lived installation access tokens on demand from the app's
 * private key and calls the GitHub REST API. Tokens are cached in memory only
 * until they expire and are never persisted, returned to a caller, or logged.
 * The app's private key is the only long-lived secret and stays in the BFF. */

export const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  fetcher?: typeof fetch;
}

export interface GitHubInstallationInfo {
  account: string;
  permissions: string[];
  repositorySelection?: string;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    throw new GitHubApiError(response.status, "the GitHub response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new GitHubApiError(response.status, "the GitHub response is too large");
  return text;
}

export class GitHubAppGateway {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly fetcher: typeof fetch;
  private readonly tokens = new Map<number, TokenCacheEntry>();

  constructor(options: GitHubAppOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKey;
    this.fetcher = options.fetcher ?? fetch;
    if (!/^\d+$/.test(this.appId)) throw new Error("RELAY_CONN_GITHUB_APP_ID must be numeric");
    if (!this.privateKey.includes("PRIVATE KEY")) throw new Error("RELAY_CONN_GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }

  private appJwt(now = Date.now()): string {
    const issuedAt = Math.floor(now / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: this.appId }));
    const data = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(data).sign(this.privateKey, "base64url");
    return `${data}.${signature}`;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; authorization?: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "relay-research-connector",
    };
    if (init.authorization) headers.authorization = init.authorization;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetcher(`${GITHUB_API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubApiError(502, "GitHub is unreachable");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) throw new GitHubApiError(404, "not found on GitHub");
      if (response.status === 403 || response.status === 429) {
        throw new GitHubApiError(response.status, "GitHub rate limit reached");
      }
      throw new GitHubApiError(response.status, `GitHub refused the request (${response.status})`);
    }

    const text = await readBoundedText(response, MAX_BYTES);
    if (text.trim().length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitHubApiError(502, "GitHub returned an unreadable response");
    }
  }

  /** Metadata for an installation, used at connect time. */
  async installation(installationId: number): Promise<GitHubInstallationInfo> {
    const raw = await this.request<{
      account?: { login?: unknown };
      permissions?: Record<string, unknown>;
      repository_selection?: unknown;
    }>(`/app/installations/${installationId}`, { authorization: `Bearer ${this.appJwt()}` });
    const account = typeof raw.account?.login === "string" ? raw.account.login : "github";
    const permissions = Object.entries(raw.permissions ?? {})
      .filter(([, value]) => value === "read" || value === "write")
      .map(([name, value]) => `${name}:${String(value)}`);
    return {
      account,
      permissions,
      repositorySelection: typeof raw.repository_selection === "string" ? raw.repository_selection : undefined,
    };
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.token;
    const raw = await this.request<{ token?: unknown; expires_at?: unknown }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", authorization: `Bearer ${this.appJwt()}` },
    );
    if (typeof raw.token !== "string" || raw.token.length === 0) {
      throw new GitHubApiError(502, "GitHub did not return an installation token");
    }
    const expiresAt = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : Date.now() + 50 * 60_000;
    this.tokens.set(installationId, { token: raw.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 50 * 60_000 });
    return raw.token;
  }

  /** Run a REST call as an installation (private access) or anonymously
   * (public data), with a per-installation token minted on demand. */
  async rest<T>(
    path: string,
    init: { installationId?: number; method?: string; body?: unknown } = {},
  ): Promise<T> {
    const authorization = init.installationId !== undefined
      ? `Bearer ${await this.installationToken(init.installationId)}`
      : undefined;
    return this.request<T>(path, { method: init.method, body: init.body, authorization });
  }

  /** Best-effort uninstall using the app JWT. A 404 means it is already gone. */
  async deleteInstallation(installationId: number): Promise<void> {
    try {
      await this.request(`/app/installations/${installationId}`, {
        method: "DELETE",
        authorization: `Bearer ${this.appJwt()}`,
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }
}
