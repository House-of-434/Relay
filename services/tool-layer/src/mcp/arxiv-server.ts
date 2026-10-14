import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeArxiv } from "../domain/permissions.js";
import type { ArxivProvider } from "../infra/arxiv.js";

export interface ArxivToolContext {
  provider: ArxivProvider;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Scout's scholarly search: arXiv papers by keyword, title, author, category,
 * or date range, plus retrieval by id. Public, no account. */
export function registerArxivTools(server: McpServer, agent: Agent, context: ArxivToolContext): void {
  const { provider } = context;

  server.registerTool(
    "arxiv_search",
    {
      description:
        "Search arXiv for research papers. Combine a free-text query with optional title, author, or category filters and a submission date range. Returns normalized results (source, canonical URL, authors, dates, abstract) for citation.",
      inputSchema: {
        query: z.string().max(512).optional(),
        title: z.string().max(256).optional(),
        author: z.string().max(256).optional(),
        category: z.string().max(64).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sort: z.enum(["relevance", "submitted", "updated"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeArxiv(agent, "search");
        const results = await provider.search({ ...input, query: input.query ?? "" });
        return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "arxiv_get",
    {
      description: "Fetch one arXiv paper's metadata and abstract by id (for example 2401.12345 or 2401.12345v2). Read-only.",
      inputSchema: { id: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        authorizeArxiv(agent, "get");
        const paper = await provider.get(id);
        if (!paper) return toolError(new Error(`no arXiv paper found for id ${id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify({ paper }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
