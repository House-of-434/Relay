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
        "Search a company's SEC filings by form type and date range. Set includeHistory to reach filings older than EDGAR's recent window. Returns normalized results with canonical EDGAR URLs. Read-only.",
      inputSchema: {
        company: z.string().min(1).max(256),
        formType: z.string().min(1).max(32).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        includeHistory: z.boolean().optional(),
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
    "sec_search_text",
    {
      description:
        "Full-text search across all SEC EDGAR filings by keyword or quoted phrase, optionally limited to form types and a filing-date range. Returns matching filings with canonical EDGAR URLs. Read-only.",
      inputSchema: {
        query: z.string().min(1).max(512),
        forms: z.string().min(1).max(128).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "text");
        const filings = await provider.searchFullText(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ filings }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sec_get_filing",
    {
      description:
        "Read a filing document as bounded plain text, given the company and accession number (from sec_search_filings or sec_search_text) and optionally a document file name. The body is truncated to a fixed size. Read-only.",
      inputSchema: {
        company: z.string().min(1).max(256),
        accessionNumber: z.string().min(1).max(64),
        document: z.string().min(1).max(256).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "filing");
        const filing = await provider.getFiling(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ filing }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sec_company_facts",
    {
      description:
        "Read a company's XBRL facts (for example Revenues or Assets), optionally filtered by taxonomy, tag, unit, or period end date. Returns recent values per tag. Read-only.",
      inputSchema: {
        company: z.string().min(1).max(256),
        tag: z.string().min(1).max(128).optional(),
        taxonomy: z.string().min(1).max(32).optional(),
        unit: z.string().min(1).max(32).optional(),
        period: isoDate.optional(),
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

  server.registerTool(
    "sec_compare_facts",
    {
      description:
        "Compare one XBRL fact tag across two to ten companies for like-for-like analysis. Returns each company's values for the tag in the selected unit (and optional period end date). Read-only.",
      inputSchema: {
        companies: z.array(z.string().min(1).max(256)).min(2).max(10),
        tag: z.string().min(1).max(128),
        taxonomy: z.string().min(1).max(32).optional(),
        unit: z.string().min(1).max(32).optional(),
        period: isoDate.optional(),
        limit: z.number().int().min(1).max(40).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "compare");
        const facts = await provider.compareFacts(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ facts }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "sec_frames",
    {
      description:
        "Read an XBRL frame: one fact tag and unit reported by every filer for a calendar year, with an optional quarter and instant flag for balance-sheet frames. Returns up to the requested number of filers. Read-only.",
      inputSchema: {
        tag: z.string().min(1).max(128),
        unit: z.string().min(1).max(32),
        year: z.number().int().min(1994).max(2100),
        quarter: z.number().int().min(1).max(4).optional(),
        instant: z.boolean().optional(),
        taxonomy: z.string().min(1).max(32).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        authorizeSec(agent, "frames");
        const facts = await provider.frames(input);
        return { content: [{ type: "text" as const, text: JSON.stringify({ facts }) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
