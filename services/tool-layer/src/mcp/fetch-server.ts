import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeFetch } from "../domain/permissions.js";
import type { FetchProvider } from "../infra/fetch.js";

export interface FetchToolContext {
  provider: FetchProvider;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Scout's default page reader: one URL in, readable content out. The
 * browser tools are the escalation path. */
export function registerFetchTools(server: McpServer, agent: Agent, context: FetchToolContext): void {
  const { provider } = context;

  server.registerTool(
    "web_fetch",
    {
      description:
        "Fetch a URL and return readable content, in Markdown by default. Supports JavaScript-rendered pages. Use for ordinary page reads; switch to browser tools if content is missing, incomplete, requires interaction, or needs structured extraction.",
      inputSchema: {
        url: z.string().min(1).max(2048),
        format: z.enum(["markdown", "html"]).optional(),
        links: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, format, links }) => {
      try {
        authorizeFetch(agent, "fetch");
        const result = await provider.fetch(url, { format, links });
        const parts = [result.text];
        if (result.links && result.links.length > 0) {
          parts.push(`\n\nLinks:\n${result.links.map((link) => `- ${link}`).join("\n")}`);
        }
        if (result.truncated) parts.push(`\n\n[content truncated to ${result.text.length} characters]`);
        return { content: [{ type: "text" as const, text: parts.join("") }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
