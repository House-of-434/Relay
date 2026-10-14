/** GitHub connector client.
 *
 * The Tool Layer never holds a GitHub credential. GitHub access is
 * authenticated per user through the BFF: the client authorizes the operation,
 * then asks the BFF to run it with the signed actor assertion it already
 * verified. The BFF attaches the actor's own installation token (private
 * access) or calls GitHub anonymously for public data, and derives everything
 * from the verified identity — never from these arguments.
 *
 * Provider-specific payloads are narrowed to the shared ConnectorResult shape
 * here, so GitHub's API fields stay on this side of the boundary. */

import { boundedText, isHttpUrl, type ConnectorResult } from "../domain/connector-result.js";

export const GITHUB_INTERNAL_PATHS = {
  repositoriesSearch: "/api/internal/github/repositories/search",
  repositoryGet: "/api/internal/github/repositories/get",
  repositoryContents: "/api/internal/github/repositories/contents",
  issuesSearch: "/api/internal/github/issues/search",
  releases: "/api/internal/github/repositories/releases",
} as const;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BODY_MAX = 20_000;

export function assertRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!REPO_PATTERN.test(trimmed)) throw new Error("repo must look like owner/name");
  return trimmed;
}

export class GitHubRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

export interface RelayGitHubClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

export interface GitHubRepositorySummary {
  fullName: string;
  url: string;
  description?: string;
  stars?: number;
  updatedAt?: string;
  private: boolean;
}

export class RelayGitHubClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayGitHubClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async call<Result>(path: string, actorAssertion: string, payload: unknown): Promise<Result> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new GitHubRequestError(503, "the GitHub connector service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new GitHubRequestError(502, "the GitHub connector service is unreachable");
    }
    if (!response.ok) throw new GitHubRequestError(response.status, await safeErrorMessage(response));
    return await response.json() as Result;
  }

  searchRepositories(actorAssertion: string, input: { query: string; sort?: string; order?: string; limit?: number }) {
    return this.call<{ items: GitHubRepositorySummary[] }>(GITHUB_INTERNAL_PATHS.repositoriesSearch, actorAssertion, input);
  }

  getRepository(actorAssertion: string, input: { repo: string }) {
    return this.call<{ repository: GitHubRepositorySummary }>(GITHUB_INTERNAL_PATHS.repositoryGet, actorAssertion, input);
  }

  getFile(actorAssertion: string, input: { repo: string; path: string; ref?: string }) {
    return this.call<{ path: string; url?: string; content?: string; truncated: boolean }>(
      GITHUB_INTERNAL_PATHS.repositoryContents,
      actorAssertion,
      input,
    );
  }

  searchIssues(actorAssertion: string, input: { query: string; repo?: string; limit?: number }) {
    return this.call<GitHubIssueResponse>(GITHUB_INTERNAL_PATHS.issuesSearch, actorAssertion, input);
  }

  listReleases(actorAssertion: string, input: { repo: string; limit?: number }) {
    return this.call<{ releases: GitHubReleaseSummary[] }>(GITHUB_INTERNAL_PATHS.releases, actorAssertion, input);
  }
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  state?: string;
  updatedAt?: string;
  isPullRequest: boolean;
  repo?: string;
  body?: string;
}

export interface GitHubIssueResponse {
  items: GitHubIssueSummary[];
}

export interface GitHubReleaseSummary {
  repo?: string;
  tagName: string;
  name?: string;
  url: string;
  publishedAt?: string;
  body?: string;
}

export function repositoryResult(repo: GitHubRepositorySummary): ConnectorResult {
  const fullName = repo.fullName.trim();
  if (!REPO_PATTERN.test(fullName)) throw new Error("GitHub repository payload is missing owner/name");
  const canonicalUrl = isHttpUrl(repo.url) ? repo.url : `https://github.com/${fullName}`;
  if (!isHttpUrl(canonicalUrl)) throw new Error("GitHub repository payload is missing a usable URL");
  return {
    source: "github",
    sourceId: fullName,
    canonicalUrl,
    title: fullName,
    updatedAt: repo.updatedAt,
    content: boundedText(repo.description, 1_000),
    metadata: { private: repo.private, stars: repo.stars },
  };
}

export function issueResult(issue: GitHubIssueSummary): ConnectorResult {
  if (!Number.isInteger(issue.number) || issue.number <= 0) throw new Error("GitHub issue payload is missing a usable number");
  if (!isHttpUrl(issue.url)) throw new Error("GitHub issue payload is missing a usable URL");
  return {
    source: "github",
    sourceId: `${issue.repo ?? ""}#${issue.number}`,
    canonicalUrl: issue.url,
    title: issue.title,
    updatedAt: issue.updatedAt,
    content: boundedText(issue.body, 2_000),
    metadata: { number: issue.number, state: issue.state, pullRequest: issue.isPullRequest, repo: issue.repo },
  };
}

export function releaseResult(release: GitHubReleaseSummary): ConnectorResult {
  const tag = release.tagName.trim();
  if (tag.length === 0) throw new Error("GitHub release payload is missing a usable tag");
  if (!isHttpUrl(release.url)) throw new Error("GitHub release payload is missing a usable URL");
  const repo = (release.repo ?? "").trim();
  if (!REPO_PATTERN.test(repo)) throw new Error("GitHub release payload is missing a usable repository");
  return {
    source: "github",
    sourceId: `${repo}#${tag}`,
    canonicalUrl: release.url,
    title: release.name ?? tag,
    publishedAt: release.publishedAt,
    content: boundedText(release.body, 4_000),
    metadata: { tag, repo },
  };
}

export function fileResult(repo: string, input: { path: string; url?: string; content?: string; truncated: boolean }): ConnectorResult {
  const canonicalUrl = isHttpUrl(input.url) ? input.url : `https://github.com/${repo}/blob/HEAD/${input.path}`;
  const collapsed = typeof input.content === "string" ? input.content.replace(/\s+/g, " ").trim() : "";
  const truncated = input.truncated || collapsed.length > BODY_MAX;
  return {
    source: "github",
    sourceId: `${repo}:${input.path}`,
    canonicalUrl,
    title: input.path,
    content: boundedText(input.content, BODY_MAX),
    metadata: { repo, path: input.path, truncated },
  };
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
      ? body.error
      : "the GitHub request was refused";
  } catch {
    return "the GitHub request was refused";
  }
}
