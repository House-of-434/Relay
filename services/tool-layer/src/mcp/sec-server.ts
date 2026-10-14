import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeSec } from "../domain/permissions.js";
import type { SecProvider } from "../infra/sec.js";

export interface SecToolContext {
  provider: SecProvider;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Scout's SEC EDGAR research: resolve a company to its CIK, search recent
 * filings by form type and date, and read XBRL company facts. Public. */
export function registerSecTools(server: McpServer, agent: Agent, context: SecToolContext): void {
  const { provider } = context;

  server.registerTool(
    "sec_resolve_company",
    {
      description: "Resolve a company name or ticker to SEC EDGAR identifiers (CIK, ticker, title). Read-only.",
      inputSchema: { query: z.string().min(1).max(256) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      try {
        authorizeSec(agent, "resolve");
        const companies = await provider.resolveCompany(query);
        return { content: [{ type: "text" as const, text: JSON.stringify({ companies }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sec_search_filings",
    {
      description:
        "Search a company's recent SEC filings by form type and date range. Returns normalized results with canonical EDGAR URLs. Read-only.",
      inputSchema: {
        company: z.string().min(1).max(256),
        formType: z.string().min(1).max(32).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "filings");
        const filings = await provider.searchFilings(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ filings }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sec_company_facts",
    {
      description:
        "Read a company's XBRL facts (for example Revenues or Assets), optionally filtered by taxonomy, tag, or unit. Returns recent values per tag. Read-only.",
      inputSchema: {
        company: z.string().min(1).max(256),
        tag: z.string().min(1).max(128).optional(),
        taxonomy: z.string().min(1).max(32).optional(),
        unit: z.string().min(1).max(32).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "facts");
        const facts = await provider.companyFacts(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ facts }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
