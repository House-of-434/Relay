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

/** Scout's browser: interactive navigation, persistent page state, and
 * site-aware structured extraction inside the calling user's own browser
 * workspace. */
export function registerBrowserTools(server: McpServer, agent: Agent, context: BladeBrowserContext): void {
  const { pool, userId } = context;

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a URL in the persistent research browser. Use for clicking, navigating, expanding content, interacting with pages, or maintaining state across steps. Returns bounded page text.",
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
        "Read the current browser page: content, headings, find text, or page through a large artifact. Use the narrowest mode that answers the question.",
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
        "Extract structured page data such as repository rankings, comment threads, products, links, or forms. Use when relationships between fields matter and plain text is insufficient. Reports blocked pages rather than fabricating results.",
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
