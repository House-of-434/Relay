import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeBrowser } from "../domain/permissions.js";
import type { BladeBrowserPool, ExtractKind, ReadMode } from "../infra/bladebro.js";

export interface BladeBrowserContext {
  pool: BladeBrowserPool;
  userId: string;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function withArtifactNote(text: string, artifact: string | undefined): string {
  if (!artifact) return text;
  return `${text}\n\nFull output is in workspace artifact ${artifact} (this user only); use browser_read with mode "artifact" to page it.`;
}

const READ_MODES = ["content", "outline", "find", "artifact"] as const;
const EXTRACT_KINDS = ["auto", "links", "forms"] as const;

/** Scout's research browser: rendered pages, JavaScript, links, and
 * structured extraction inside the calling user's own browser workspace.
 * Available on normal and deep research alike — depth is orchestration,
 * not tooling. */
export function registerBrowserTools(server: McpServer, agent: Agent, context: BladeBrowserContext): void {
  const { pool, userId } = context;

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a URL in the research browser and read the rendered page: JavaScript runs, feeds expand, links resolve. Prefer this when web_search finds a promising result that needs real reading, or when a page needs interaction. Returns bounded text; oversized pages spill to a paged artifact.",
      inputSchema: { url: z.string().min(1).max(2048) },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      try {
        authorizeBrowser(agent, "open");
        const result = await pool.open(userId, url);
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_read",
    {
      description:
        "Read the current page: content (clean markdown), outline (headings only, cheapest), find (locate text and return refs), or artifact (page a spilled artifact by name with offset/limit). Use outline first on unknown pages; escalate only what you need.",
      inputSchema: {
        mode: z.enum(READ_MODES),
        query: z.string().min(1).max(512).optional(),
        artifact: z.string().min(1).max(256).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(32_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ mode, query, artifact, offset, limit }) => {
      try {
        authorizeBrowser(agent, "read");
        const result = await pool.read(userId, mode as ReadMode, query, artifact, offset, limit);
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_extract",
    {
      description:
        "Extract structured data from a page: auto (site-aware lists — comment trees, threads, repos, products — in one call), links, or forms. Pass a URL to navigate first, or omit it to extract the current page. Blocked or challenged pages report honestly instead of fabricating.",
      inputSchema: {
        url: z.string().min(1).max(2048).optional(),
        kind: z.enum(EXTRACT_KINDS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, kind }) => {
      try {
        authorizeBrowser(agent, "extract");
        const result = await pool.extract(userId, url ?? null, (kind ?? "auto") as ExtractKind);
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
