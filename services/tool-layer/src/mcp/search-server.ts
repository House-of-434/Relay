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

/** Scout's discovery capability: fast web search returning URL, title,
 * and snippet per result. Which provider answers is Tool Layer
 * infrastructure the model never sees. Search finds candidates; the
 * browser (`browser_open` / `browser_read` / `browser_extract`) reads
 * them. Escalate whenever a result needs real reading — especially
 * JavaScript-heavy pages, live rankings, and full threads.
 *
 * Provider notes the planner should respect: domain filters are honored;
 * there is no freshness filter on the current provider, so recency is
 * judged from result dates and snippets instead. */
export function registerSearchTools(server: McpServer, agent: Agent, context: SearchToolContext): void {
  const { provider } = context;

  server.registerTool(
    "web_search",
    {
      description:
        "Search the web for candidate sources: official announcements, docs, repos, reporting. Returns URL, title, and snippet per result — open the promising ones with browser_open and read them with browser_read. Domain filters narrow to (or away from) named sites; freshness is judged from result dates.",
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
