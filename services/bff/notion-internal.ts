import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { RelayActor, RelayAgentRole } from "./actor-assertion.ts";
import { jsonResponse, verifyInternalRequest } from "./internal-request.ts";
import { normalizeNotionId, notionRequest, uploadNotionFile, NOTION_FILE_API_VERSION, NotionApiError } from "./notion-api.ts";
import type { NotionConnectionStore } from "./notion-connections.ts";

export const INTERNAL_NOTION_SEARCH = "/api/internal/notion/search";
export const INTERNAL_NOTION_GET = "/api/internal/notion/get";
export const INTERNAL_NOTION_QUERY = "/api/internal/notion/query";
export const INTERNAL_NOTION_CREATE = "/api/internal/notion/create";
export const INTERNAL_NOTION_UPDATE = "/api/internal/notion/update";
export const INTERNAL_NOTION_ATTACH = "/api/internal/notion/attach";

const INTERNAL_NOTION_PATHS = [
  INTERNAL_NOTION_SEARCH,
  INTERNAL_NOTION_GET,
  INTERNAL_NOTION_QUERY,
  INTERNAL_NOTION_CREATE,
  INTERNAL_NOTION_UPDATE,
  INTERNAL_NOTION_ATTACH,
] as const;

/** Reads are shared research; writes stay with the agent that owns the
 * inbox-driven Dealflow flow. Enforced here independently of the Tool Layer. */
const NOTION_READ_AGENTS: ReadonlySet<RelayAgentRole> = new Set<RelayAgentRole>(["scout", "mercury", "curator"]);
const NOTION_WRITE_AGENTS: ReadonlySet<RelayAgentRole> = new Set<RelayAgentRole>(["mercury"]);

const MAX_QUERY_LENGTH = 512;
const MAX_ID_LENGTH = 64;
const MAX_PAGE_SIZE = 100;
const MAX_PROPERTIES_BYTES = 64 * 1024;
const MAX_FILTER_BYTES = 8 * 1024;
const MAX_PAGE_BYTES = 200 * 1024;

const searchSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict();

const getSchema = z.object({ pageId: z.string().min(1).max(MAX_ID_LENGTH) }).strict();

const querySchema = z.object({
  databaseId: z.string().min(1).max(MAX_ID_LENGTH),
  filter: z.record(z.string(), z.unknown()).optional(),
  sorts: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  startCursor: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict();

const createSchema = z.object({
  databaseId: z.string().min(1).max(MAX_ID_LENGTH),
  properties: z.record(z.string(), z.unknown()),
}).strict();

const updateSchema = z.object({
  pageId: z.string().min(1).max(MAX_ID_LENGTH),
  properties: z.record(z.string(), z.unknown()),
}).strict();

/** Attach a file the actor already holds (an email attachment) to a page's
 * files property. The bytes never travel through the model: the BFF fetches
 * the Gmail attachment server-side and uploads it to Notion. */
const attachSchema = z.object({
  pageId: z.string().min(1).max(MAX_ID_LENGTH),
  property: z.string().min(1).max(200),
  messageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(512),
  mailbox: z.enum(["own", "relay"]).optional(),
}).strict();

export interface FetchedAttachment {
  filename: string;
  mimeType: string;
  /** Standard base64 bytes. */
  data: string;
}

export interface InternalNotionOptions {
  capability: string;
  actorSecret: string | undefined;
  connections: NotionConnectionStore;
  /** Normalized (32-hex, lowercase) database ids the server may write to.
   * Empty fails writes closed; reads are unaffected. */
  allowedDatabaseIds: string[];
  /** Resolve one Gmail attachment's bytes for the verified actor. Supplied by
   * the BFF, which owns the Gmail gateway; absent disables attach. */
  fetchAttachment?: (actor: RelayActor, input: {
    messageId: string;
    attachmentId: string;
    mailbox?: "own" | "relay";
  }) => Promise<FetchedAttachment>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function isInternalNotionPath(pathname: string): boolean {
  return (INTERNAL_NOTION_PATHS as readonly string[]).includes(pathname);
}

interface NotionParent {
  type?: unknown;
  database_id?: unknown;
}

interface NotionPage {
  id?: unknown;
  url?: unknown;
  parent?: NotionParent;
  properties?: Record<string, unknown>;
}

function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Record<string, unknown>;
      const text = record.text as Record<string, unknown> | undefined;
      if (record.type === "text" && text && typeof text.content === "string") return text.content;
      return typeof record.plain_text === "string" ? record.plain_text : "";
    })
    .join("");
}

function pageTitle(item: { properties?: Record<string, unknown>; title?: unknown }): string {
  if (Array.isArray(item.title)) return richTextToPlain(item.title).slice(0, 200);
  const properties = item.properties ?? {};
  for (const prop of Object.values(properties)) {
    if (prop && typeof prop === "object" && (prop as Record<string, unknown>).type === "title") {
      return richTextToPlain((prop as Record<string, unknown>).title).slice(0, 200);
    }
  }
  return "";
}

function searchSummary(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof item.id !== "string" || typeof item.object !== "string") return undefined;
  return {
    id: item.id,
    object: item.object,
    title: pageTitle(item as { properties?: Record<string, unknown>; title?: unknown }),
    ...(typeof item.url === "string" ? { url: item.url } : {}),
  };
}

function pageSummary(page: NotionPage): Record<string, unknown> | undefined {
  if (typeof page.id !== "string" || !page.properties || typeof page.properties !== "object") return undefined;
  const serialized = JSON.stringify(page.properties);
  if (serialized.length > MAX_PAGE_BYTES) return undefined;
  return {
    id: page.id,
    ...(typeof page.url === "string" ? { url: page.url } : {}),
    properties: page.properties,
  };
}

function boundedJsonSize(value: unknown, max: number): boolean {
  try {
    return JSON.stringify(value).length <= max;
  } catch {
    return false;
  }
}

/**
 * Notion is reachable only for a verified actor with a connected workspace.
 * The connection is resolved from the actor identity — a caller can never name
 * a user, workspace, or token. Writes additionally require the target
 * database to be on the operator allowlist (the Dealflow copy during eval).
 */
export async function handleInternalNotion(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalNotionOptions,
): Promise<void> {
  const verified = await verifyInternalRequest(req, res, pathname, options, pathname);
  if (!verified) return;
  const { actor, body } = verified;

  if (!NOTION_READ_AGENTS.has(actor.agent)) {
    jsonResponse(res, 403, { error: "this agent may not use the Notion connector" });
    return;
  }

  const accessToken = await options.connections.accessTokenForDefault(actor.userId);
  if (!accessToken) {
    jsonResponse(res, 409, { error: "Notion is not connected for this user" });
    return;
  }

  try {
    await dispatch(req, res, pathname, options, actor, accessToken, body);
  } catch (error) {
    if (error instanceof NotionApiError) {
      jsonResponse(res, error.status >= 400 && error.status < 500 ? error.status : 502, { error: error.message });
      return;
    }
    jsonResponse(res, 502, { error: "Notion request failed" });
  }
}

async function dispatch(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalNotionOptions,
  actor: RelayActor,
  accessToken: string,
  body: unknown,
): Promise<void> {
  const fetcher = options.fetcher;
  const agent = actor.agent;

  if (pathname === INTERNAL_NOTION_SEARCH) {
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid Notion search" });
      return;
    }
    const raw = await notionRequest<{ results?: unknown[] }>({
      accessToken,
      path: "/search",
      method: "POST",
      body: { query: parsed.data.query, page_size: parsed.data.pageSize ?? 20 },
      fetcher,
    });
    const results = (raw.results ?? [])
      .map((item) => (item && typeof item === "object" ? searchSummary(item as Record<string, unknown>) : undefined))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    jsonResponse(res, 200, { results });
    return;
  }

  if (pathname === INTERNAL_NOTION_GET) {
    const parsed = getSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.pageId)) {
      jsonResponse(res, 400, { error: "invalid Notion page id" });
      return;
    }
    const page = await notionRequest<NotionPage>({ accessToken, path: `/pages/${parsed.data.pageId}`, fetcher });
    const summary = pageSummary(page);
    if (!summary) {
      jsonResponse(res, 502, { error: "the Notion page is too large to summarize" });
      return;
    }
    jsonResponse(res, 200, { page: summary });
    return;
  }

  if (pathname === INTERNAL_NOTION_QUERY) {
    const parsed = querySchema.safeParse(body);
    const databaseId = parsed.success ? normalizeNotionId(parsed.data.databaseId) : undefined;
    if (!parsed.success || !databaseId) {
      jsonResponse(res, 400, { error: "invalid Notion database query" });
      return;
    }
    if (parsed.data.filter !== undefined && !boundedJsonSize(parsed.data.filter, MAX_FILTER_BYTES)) {
      jsonResponse(res, 400, { error: "invalid Notion database query" });
      return;
    }
    const raw = await notionRequest<{ results?: unknown[]; has_more?: unknown; next_cursor?: unknown }>({
      accessToken,
      path: `/databases/${parsed.data.databaseId}/query`,
      method: "POST",
      body: {
        ...(parsed.data.filter !== undefined ? { filter: parsed.data.filter } : {}),
        ...(parsed.data.sorts !== undefined ? { sorts: parsed.data.sorts } : {}),
        page_size: parsed.data.pageSize ?? 20,
        ...(parsed.data.startCursor ? { start_cursor: parsed.data.startCursor } : {}),
      },
      fetcher,
    });
    const rows = (raw.results ?? [])
      .map((item) => (item && typeof item === "object" ? pageSummary(item as NotionPage) : undefined))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    jsonResponse(res, 200, {
      rows,
      hasMore: raw.has_more === true,
      ...(typeof raw.next_cursor === "string" ? { nextCursor: raw.next_cursor } : {}),
    });
    return;
  }

  if (!NOTION_WRITE_AGENTS.has(agent)) {
    jsonResponse(res, 403, { error: "this agent may not write to Notion" });
    return;
  }

  if (pathname === INTERNAL_NOTION_ATTACH) {
    const parsed = attachSchema.safeParse(body);
    const pageId = parsed.success ? normalizeNotionId(parsed.data.pageId) : undefined;
    if (!parsed.success || !pageId) {
      jsonResponse(res, 400, { error: "invalid Notion attachment request" });
      return;
    }
    if (!options.fetchAttachment) {
      jsonResponse(res, 503, { error: "attachment upload is not configured" });
      return;
    }
    // Bind the write to the allowlisted parent database, exactly as update
    // does, so an attachment cannot land outside the eval copy.
    const current = await notionRequest<NotionPage>({ accessToken, path: `/pages/${parsed.data.pageId}`, fetcher });
    const parentId = typeof current.parent?.database_id === "string" ? normalizeNotionId(current.parent.database_id) : undefined;
    if (!parentId || !options.allowedDatabaseIds.includes(parentId)) {
      jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
      return;
    }
    const file = await options.fetchAttachment(actor, {
      messageId: parsed.data.messageId,
      attachmentId: parsed.data.attachmentId,
      mailbox: parsed.data.mailbox,
    });
    const uploadId = await uploadNotionFile({
      accessToken,
      filename: file.filename,
      mimeType: file.mimeType,
      data: file.data,
      fetcher,
    });
    const patched = await notionRequest<NotionPage>({
      accessToken,
      path: `/pages/${parsed.data.pageId}`,
      method: "PATCH",
      version: NOTION_FILE_API_VERSION,
      body: {
        properties: {
          [parsed.data.property]: {
            files: [{ name: file.filename, type: "file_upload", file_upload: { id: uploadId } }],
          },
        },
      },
      fetcher,
    });
    if (typeof patched.id !== "string") {
      jsonResponse(res, 502, { error: "the Notion request was refused" });
      return;
    }
    jsonResponse(res, 200, {
      page: { id: patched.id, ...(typeof patched.url === "string" ? { url: patched.url } : {}) },
      property: parsed.data.property,
      file: { name: file.filename, mimeType: file.mimeType },
    });
    return;
  }

  if (pathname === INTERNAL_NOTION_CREATE) {
    const parsed = createSchema.safeParse(body);
    const databaseId = parsed.success ? normalizeNotionId(parsed.data.databaseId) : undefined;
    if (!parsed.success || !databaseId || !boundedJsonSize(parsed.data.properties, MAX_PROPERTIES_BYTES)) {
      jsonResponse(res, 400, { error: "invalid Notion page" });
      return;
    }
    if (!options.allowedDatabaseIds.includes(databaseId)) {
      jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
      return;
    }
    const page = await notionRequest<NotionPage>({
      accessToken,
      path: "/pages",
      method: "POST",
      body: { parent: { database_id: parsed.data.databaseId }, properties: parsed.data.properties },
      fetcher,
    });
    if (typeof page.id !== "string") {
      jsonResponse(res, 502, { error: "the Notion request was refused" });
      return;
    }
    jsonResponse(res, 200, { page: { id: page.id, ...(typeof page.url === "string" ? { url: page.url } : {}) } });
    return;
  }

  // INTERNAL_NOTION_UPDATE: re-read the page and bind the write to the
  // allowlisted parent database, so a bare page id can never escape the eval
  // copy. The approval that authorized this call named these values; any
  // material change between approval and commit must go back to the human.
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success || !normalizeNotionId(parsed.data.pageId) || !boundedJsonSize(parsed.data.properties, MAX_PROPERTIES_BYTES)) {
    jsonResponse(res, 400, { error: "invalid Notion page update" });
    return;
  }
  const current = await notionRequest<NotionPage>({ accessToken, path: `/pages/${parsed.data.pageId}`, fetcher });
  const parentDatabaseId = typeof current.parent?.database_id === "string"
    ? normalizeNotionId(current.parent.database_id)
    : undefined;
  if (!parentDatabaseId || !options.allowedDatabaseIds.includes(parentDatabaseId)) {
    jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
    return;
  }
  const updated = await notionRequest<NotionPage>({
    accessToken,
    path: `/pages/${parsed.data.pageId}`,
    method: "PATCH",
    body: { properties: parsed.data.properties },
    fetcher,
  });
  if (typeof updated.id !== "string") {
    jsonResponse(res, 502, { error: "the Notion request was refused" });
    return;
  }
  jsonResponse(res, 200, { page: { id: updated.id, ...(typeof updated.url === "string" ? { url: updated.url } : {}) } });
}
