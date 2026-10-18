import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeNotion, NOTION_PERMISSIONS } from "../domain/permissions.js";
import type { RelayNotionClient } from "../infra/notion.js";

export interface NotionToolContext {
  client: RelayNotionClient;
  actorAssertion: string;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const pageSize = z.number().int().min(1).max(100).optional();
const properties = z.record(z.string(), z.unknown());

/** Dealflow Notion workspace. Reads are shared research; only Mercury may
 * create or update pages, and the BFF binds writes to the operator's
 * writable-database allowlist. Free text is preserved: select and status
 * values are written as supplied, never coerced to an app-side enum. */
export function registerNotionTools(server: McpServer, agent: Agent, context: NotionToolContext): void {
  const { client, actorAssertion } = context;

  server.registerTool(
    "notion_search",
    {
      description: "Search the connected Notion workspace by keyword (companies, pages, databases). Returns ids, titles, and URLs. Read-only; fetch a match with notion_get_page before relying on it.",
      inputSchema: { query: z.string().min(1).max(512), pageSize },
      annotations: { readOnlyHint: true },
    },
    async ({ query, pageSize: limit }) => {
      try {
        authorizeNotion(agent, "read");
        const result = await client.search(actorAssertion, { query, ...(limit ? { pageSize: limit } : {}) });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notion_get_page",
    {
      description: "Read one Notion page or database row by id, including all its properties. Read-only.",
      inputSchema: { pageId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId }) => {
      try {
        authorizeNotion(agent, "read");
        const result = await client.getPage(actorAssertion, { pageId });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notion_get_database",
    {
      description: "Read a database's schema: every property's name and type, and the existing options for select and status properties. Read-only. Call this before setting a select or status value so you reuse an option that already exists instead of creating a stray new one; it also tells you which properties a create or update will accept.",
      inputSchema: { databaseId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ databaseId }) => {
      try {
        authorizeNotion(agent, "read");
        const result = await client.getDatabase(actorAssertion, { databaseId });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notion_query_db",
    {
      description: "Query rows of one Notion database by id, for example to find an existing deal by company name. Use a title filter on the company name first; fall back to founder email when the name is ambiguous. Read-only.",
      inputSchema: {
        databaseId: z.string().min(1).max(64),
        filter: z.record(z.string(), z.unknown()).optional(),
        sorts: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
        pageSize,
        startCursor: z.string().min(1).max(64).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ databaseId, filter, sorts, pageSize: limit, startCursor }) => {
      try {
        authorizeNotion(agent, "read");
        const result = await client.queryDatabase(actorAssertion, {
          databaseId,
          ...(filter ? { filter } : {}),
          ...(sorts ? { sorts } : {}),
          ...(limit ? { pageSize: limit } : {}),
          ...(startCursor ? { startCursor } : {}),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // Write tools are registered only for agents with the write grant, so tool
  // visibility matches authorization (the BFF enforces it again on the call).
  if (!NOTION_PERMISSIONS[agent].includes("write")) return;

  server.registerTool(
    "notion_create_page",
    {
      description: "Create a row in an authorized Notion database (the Dealflow copy during evaluation). Query first: create only when no credible existing record matches. Fill only values supported by source evidence; leave uncertain fields empty and report them.",
      inputSchema: { databaseId: z.string().min(1).max(64), properties },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ databaseId, properties: props }) => {
      try {
        authorizeNotion(agent, "write");
        const result = await client.createPage(actorAssertion, { databaseId, properties: props });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notion_update_page",
    {
      description: "Update properties of an existing Notion page. Present a field-by-field diff to the human first and update only after explicit approval of those values; re-read the page immediately before committing. Never overwrite a conflicting non-empty value without approval.",
      inputSchema: { pageId: z.string().min(1).max(64), properties },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ pageId, properties: props }) => {
      try {
        authorizeNotion(agent, "write");
        const result = await client.updatePage(actorAssertion, { pageId, properties: props });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notion_attach_attachment",
    {
      description: "Attach an email attachment (for example a pitch deck) to a files property of a Notion page, uploading the file into Notion. Pass the page id, the property name (for example \"Deck\"), and the message id and attachment id from gmail_read. Use this when the deck arrived as an email attachment rather than a link; when the sender gave a link, set the files property to that external URL with notion_update_page instead.",
      inputSchema: {
        pageId: z.string().min(1).max(64),
        property: z.string().min(1).max(200),
        messageId: z.string().min(1).max(512),
        attachmentId: z.string().min(1).max(512),
        mailbox: z.enum(["own", "relay"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ pageId, property, messageId, attachmentId, mailbox }) => {
      try {
        authorizeNotion(agent, "write");
        const result = await client.attachAttachment(actorAssertion, {
          pageId,
          property,
          messageId,
          attachmentId,
          ...(mailbox ? { mailbox } : {}),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
