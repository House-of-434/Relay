import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeGithub } from "../domain/permissions.js";
import {
  assertRepo,
  fileResult,
  issueResult,
  releaseResult,
  repositoryResult,
  type RelayGitHubClient,
} from "../infra/github.js";

export interface GithubToolContext {
  client: RelayGitHubClient;
  actorAssertion: string;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const repo = z.string().min(3).max(200);

/** Scout's GitHub research. Public repositories work through the caller's own
 * authorization; private repositories are read only through the actor's own
 * installation, which the BFF resolves from the verified identity. */
export function registerGithubTools(server: McpServer, agent: Agent, context: GithubToolContext): void {
  const { client, actorAssertion } = context;

  server.registerTool(
    "github_search_repositories",
    {
      description: "Search GitHub repositories by keyword, language, topic, or owner. Returns normalized results with canonical URLs. Read-only.",
      inputSchema: {
        query: z.string().min(1).max(512),
        sort: z.enum(["stars", "forks", "updated", "best-match"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeGithub(agent, "read");
        const { items } = await client.searchRepositories(actorAssertion, {
          query: input.query,
          sort: input.sort,
          order: input.order,
          limit: input.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ results: items.map(repositoryResult) }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "github_repository",
    {
      description: "Read one GitHub repository's metadata (description, stars, visibility, last update) by owner/name. Read-only.",
      inputSchema: { repo },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: name }) => {
      try {
        authorizeGithub(agent, "read");
        const { repository } = await client.getRepository(actorAssertion, { repo: assertRepo(name) });
        return { content: [{ type: "text" as const, text: JSON.stringify({ repository: repositoryResult(repository) }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "github_read_file",
    {
      description: "Read a file from a repository (for example README.md) by owner/name and path, optionally at a ref. Read-only.",
      inputSchema: { repo, path: z.string().min(1).max(1024), ref: z.string().min(1).max(256).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: name, path, ref }) => {
      try {
        authorizeGithub(agent, "read");
        const normalized = assertRepo(name);
        const file = await client.getFile(actorAssertion, { repo: normalized, path, ref });
        return { content: [{ type: "text" as const, text: JSON.stringify({ file: fileResult(normalized, file) }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "github_search_issues",
    {
      description: "Search GitHub issues and pull requests by query, optionally within one repository. Returns normalized results. Read-only.",
      inputSchema: {
        query: z.string().min(1).max(512),
        repo: repo.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, repo: name, limit }) => {
      try {
        authorizeGithub(agent, "read");
        const scoped = name ? assertRepo(name) : undefined;
        const { items } = await client.searchIssues(actorAssertion, { query, repo: scoped, limit });
        return { content: [{ type: "text" as const, text: JSON.stringify({ results: items.map(issueResult) }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "github_releases",
    {
      description: "List recent releases for a repository by owner/name. Read-only.",
      inputSchema: { repo, limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: name, limit }) => {
      try {
        authorizeGithub(agent, "read");
        const normalized = assertRepo(name);
        const { releases } = await client.listReleases(actorAssertion, { repo: normalized, limit });
        return { content: [{ type: "text" as const, text: JSON.stringify({ results: releases.map((release) => releaseResult({ ...release, repo: release.repo ?? normalized })) }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
