import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { RelayAgentRole } from "./actor-assertion.ts";
import { jsonResponse, verifyInternalRequest } from "./internal-request.ts";
import { ConnectorStateStore } from "./connector-state.ts";
import { GitHubConnectionStore } from "./github-connections.ts";
import { GitHubApiError, GitHubAppGateway } from "./github-api.ts";

export const INTERNAL_GITHUB_REPOSITORIES_SEARCH = "/api/internal/github/repositories/search";
export const INTERNAL_GITHUB_REPOSITORY_GET = "/api/internal/github/repositories/get";
export const INTERNAL_GITHUB_REPOSITORY_CONTENTS = "/api/internal/github/repositories/contents";
export const INTERNAL_GITHUB_ISSUES_SEARCH = "/api/internal/github/issues/search";
export const INTERNAL_GITHUB_RELEASES = "/api/internal/github/repositories/releases";

const INTERNAL_GITHUB_PATHS = [
  INTERNAL_GITHUB_REPOSITORIES_SEARCH,
  INTERNAL_GITHUB_REPOSITORY_GET,
  INTERNAL_GITHUB_REPOSITORY_CONTENTS,
  INTERNAL_GITHUB_ISSUES_SEARCH,
  INTERNAL_GITHUB_RELEASES,
] as const;

/** Only Scout researches with connectors. Enforced here independently of the
 * Tool Layer so a compromise there cannot widen access. */
const CONNECTOR_AGENTS: ReadonlySet<RelayAgentRole> = new Set<RelayAgentRole>(["scout"]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_DECODE_MAX_BYTES = 200_000;

const repo = z.string().regex(REPO_PATTERN).max(200);
const limit = z.number().int().min(1).max(100).optional();

const searchRepositoriesSchema = z.object({
  query: z.string().min(1).max(512),
  sort: z.enum(["stars", "forks", "updated", "best-match"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit,
}).strict();

const repositoryGetSchema = z.object({ repo }).strict();
const contentsSchema = z.object({ repo, path: z.string().min(1).max(1024), ref: z.string().min(1).max(256).optional() }).strict();
const issuesSchema = z.object({ query: z.string().min(1).max(512), repo: repo.optional(), limit }).strict();
const releasesSchema = z.object({ repo, limit }).strict();

export interface InternalGitHubOptions {
  capability: string;
  actorSecret: string | undefined;
  connectorState: ConnectorStateStore;
  connections: GitHubConnectionStore;
  app: GitHubAppGateway;
  now?: () => number;
}

export function isInternalGitHubPath(pathname: string): boolean {
  return (INTERNAL_GITHUB_PATHS as readonly string[]).includes(pathname);
}

interface RawRepository {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  updated_at?: unknown;
  private?: unknown;
}

function repositorySummary(raw: RawRepository): Record<string, unknown> {
  return {
    fullName: typeof raw.full_name === "string" ? raw.full_name : "",
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    description: typeof raw.description === "string" ? raw.description : undefined,
    stars: typeof raw.stargazers_count === "number" ? raw.stargazers_count : undefined,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    private: raw.private === true,
  };
}

function isHttpLike(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));
}

function hasUsableRepo(item: Record<string, unknown>): boolean {
  return typeof item.fullName === "string" && item.fullName.length > 0 && isHttpLike(item.url);
}

function hasUsableIssue(item: { number: unknown; url: unknown; repo: unknown }): boolean {
  return typeof item.number === "number" && Number.isInteger(item.number) && item.number > 0 && isHttpLike(item.url) && typeof item.repo === "string" && REPO_PATTERN.test(item.repo);
}

function hasUsableRelease(item: { tagName: unknown; url: unknown }): boolean {
  return typeof item.tagName === "string" && item.tagName.length > 0 && isHttpLike(item.url);
}

function repoFromApiUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /repos\/([^/]+)\/([^/]+)$/.exec(value);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function resolveInstallation(options: InternalGitHubOptions, userId: string): Promise<number | undefined> {
  const connection = await options.connections.find(userId);
  return connection?.installationId;
}

/**
 * GitHub is reachable only for a verified actor, and only when that user has
 * enabled the connector and connected an installation. Installation tokens are
 * minted per request by the app gateway and never leave the BFF. A caller can
 * never name a user, installation, or token.
 */
export async function handleInternalGitHub(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalGitHubOptions,
): Promise<void> {
  const verified = await verifyInternalRequest(req, res, pathname, options, pathname);
  if (!verified) return;
  const { actor, body } = verified;

  if (!CONNECTOR_AGENTS.has(actor.agent)) {
    jsonResponse(res, 403, { error: "this agent may not use research connectors" });
    return;
  }

  const enablement = await options.connectorState.get(actor.userId);
  if (!enablement.github) {
    jsonResponse(res, 409, { error: "GitHub is disabled for this account" });
    return;
  }
  const installationId = await resolveInstallation(options, actor.userId);
  if (installationId === undefined) {
    jsonResponse(res, 409, { error: "GitHub is not connected for this user" });
    return;
  }

  try {
    await dispatch(req, res, pathname, options, actor.userId, installationId, body);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      jsonResponse(res, error.status === 404 ? 404 : 502, { error: error.message });
      return;
    }
    jsonResponse(res, 502, { error: "GitHub request failed" });
  }
}

async function dispatch(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalGitHubOptions,
  userId: string,
  installationId: number,
  body: unknown,
): Promise<void> {
  void userId;

  if (pathname === INTERNAL_GITHUB_REPOSITORIES_SEARCH) {
    const parsed = searchRepositoriesSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid repository search" });
      return;
    }
    const params = new URLSearchParams({ q: parsed.data.query, per_page: String(parsed.data.limit ?? 20) });
    if (parsed.data.sort && parsed.data.sort !== "best-match") params.set("sort", parsed.data.sort);
    if (parsed.data.order) params.set("order", parsed.data.order);
    const raw = await options.app.rest<{ items?: RawRepository[] }>(
      `/search/repositories?${params.toString()}`,
      { installationId },
    );
    jsonResponse(res, 200, { items: (raw.items ?? []).map(repositorySummary).filter(hasUsableRepo) });
    return;
  }

  if (pathname === INTERNAL_GITHUB_REPOSITORY_GET) {
    const parsed = repositoryGetSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid repository" });
      return;
    }
    const raw = await options.app.rest<RawRepository>(`/repos/${parsed.data.repo}`, { installationId });
    const repository = repositorySummary(raw);
    if (!hasUsableRepo(repository)) {
      jsonResponse(res, 502, { error: "GitHub request failed" });
      return;
    }
    jsonResponse(res, 200, { repository });
    return;
  }

  if (pathname === INTERNAL_GITHUB_REPOSITORY_CONTENTS) {
    const parsed = contentsSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid file request" });
      return;
    }
    const query = parsed.data.ref ? `?ref=${encodeURIComponent(parsed.data.ref)}` : "";
    const raw = await options.app.rest<{
      path?: unknown;
      html_url?: unknown;
      content?: unknown;
      encoding?: unknown;
      size?: unknown;
    }>(`/repos/${parsed.data.repo}/contents/${parsed.data.path.split("/").map(encodeURIComponent).join("/")}${query}`, {
      installationId,
    });
    if (Array.isArray(raw) || raw.encoding !== "base64" || typeof raw.content !== "string") {
      jsonResponse(res, 400, { error: "the requested path is not a readable file" });
      return;
    }
    const decoded = Buffer.from(raw.content, "base64").toString("utf8");
    const truncated = decoded.length > FILE_DECODE_MAX_BYTES;
    jsonResponse(res, 200, {
      path: typeof raw.path === "string" ? raw.path : parsed.data.path,
      url: typeof raw.html_url === "string" ? raw.html_url : undefined,
      content: truncated ? decoded.slice(0, FILE_DECODE_MAX_BYTES) : decoded,
      truncated,
    });
    return;
  }

  if (pathname === INTERNAL_GITHUB_ISSUES_SEARCH) {
    const parsed = issuesSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid issue search" });
      return;
    }
    const query = parsed.data.repo ? `repo:${parsed.data.repo} ${parsed.data.query}` : parsed.data.query;
    const params = new URLSearchParams({ q: query, per_page: String(parsed.data.limit ?? 20) });
    const raw = await options.app.rest<{ items?: Array<Record<string, unknown>> }>(
      `/search/issues?${params.toString()}`,
      { installationId },
    );
    const items = (raw.items ?? []).map((item) => ({
      number: typeof item.number === "number" ? item.number : 0,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.html_url === "string" ? item.html_url : "",
      state: typeof item.state === "string" ? item.state : undefined,
      updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
      isPullRequest: item.pull_request !== undefined,
      repo: repoFromApiUrl(item.repository_url),
      body: typeof item.body === "string" ? item.body : undefined,
    })).filter(hasUsableIssue);
    jsonResponse(res, 200, { items });
    return;
  }

  // INTERNAL_GITHUB_RELEASES
  const parsed = releasesSchema.safeParse(body);
  if (!parsed.success) {
    jsonResponse(res, 400, { error: "invalid releases request" });
    return;
  }
  const raw = await options.app.rest<Array<{ tag_name?: unknown; name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown }>>(
    `/repos/${parsed.data.repo}/releases?per_page=${parsed.data.limit ?? 20}`,
    { installationId },
  );
  jsonResponse(res, 200, {
    releases: (Array.isArray(raw) ? raw : []).map((release) => ({
      tagName: typeof release.tag_name === "string" ? release.tag_name : "",
      name: typeof release.name === "string" ? release.name : undefined,
      url: typeof release.html_url === "string" ? release.html_url : "",
      publishedAt: typeof release.published_at === "string" ? release.published_at : undefined,
      body: typeof release.body === "string" ? release.body : undefined,
    })).filter(hasUsableRelease),
  });
}
