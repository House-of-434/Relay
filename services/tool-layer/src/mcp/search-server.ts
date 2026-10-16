import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeSearch } from "../domain/permissions.js";
import type { SearchProvider } from "../infra/search.js";

export interface SearchToolContext {
  provider: SearchProvider;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Scout's web discovery: a query in, candidate sources out (URL, title,
 * snippet). Which provider answers is Tool Layer infrastructure the model
 * never sees. Domain filters are honored; freshness is judged from result
 * dates. */
export function registerSearchTools(server: McpServer, agent: Agent, context: SearchToolContext): void {
  const { provider } = context;

  server.registerTool(
    "web_search",
    {
      description:
        "Discover candidate sources. Find relevant web pages for a query. Returns URLs, titles, and snippets to guide further research. Use when the target source is unknown; use web_fetch to read a known URL.",
      inputSchema: {
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(20).optional(),
        include_domains: z.array(z.string().min(1).max(253)).max(10).optional(),
        exclude_domains: z.array(z.string().min(1).max(253)).max(10).optional(),
        language: z.string().min(2).max(16).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, include_domains, exclude_domains, language }) => {
      try {
        authorizeSearch(agent, "search");
        const results = await provider.search(query, {
          limit: limit ?? undefined,
          includeDomains: include_domains,
          excludeDomains: exclude_domains,
          language: language ?? undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
