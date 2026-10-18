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
export const INTERNAL_NOTION_DATABASE_GET = "/api/internal/notion/database";
export const INTERNAL_NOTION_PAGE_CONTENT = "/api/internal/notion/blocks/children";
export const INTERNAL_NOTION_APPEND_CONTENT = "/api/internal/notion/blocks/append";
export const INTERNAL_NOTION_ARCHIVE = "/api/internal/notion/pages/archive";
export const INTERNAL_NOTION_USERS = "/api/internal/notion/users";
export const INTERNAL_NOTION_COMMENTS = "/api/internal/notion/comments";
export const INTERNAL_NOTION_COMMENT_ADD = "/api/internal/notion/comments/add";

const INTERNAL_NOTION_PATHS = [
  INTERNAL_NOTION_SEARCH,
  INTERNAL_NOTION_GET,
  INTERNAL_NOTION_QUERY,
  INTERNAL_NOTION_CREATE,
  INTERNAL_NOTION_UPDATE,
  INTERNAL_NOTION_ATTACH,
  INTERNAL_NOTION_DATABASE_GET,
  INTERNAL_NOTION_PAGE_CONTENT,
  INTERNAL_NOTION_APPEND_CONTENT,
  INTERNAL_NOTION_ARCHIVE,
  INTERNAL_NOTION_USERS,
  INTERNAL_NOTION_COMMENTS,
  INTERNAL_NOTION_COMMENT_ADD,
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
/** Block reads and writes stay bounded: a page body can be large, so a read
 * returns one bounded page of block summaries with a cursor, and an append is
 * capped in both block count and payload size. */
const MAX_BLOCK_TEXT = 2_000;
const MAX_APPEND_BLOCKS = 50;
const MAX_APPEND_BYTES = 128 * 1024;
const MAX_COMMENT_LENGTH = 2_000;

const searchSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict();

const getSchema = z.object({ pageId: z.string().min(1).max(MAX_ID_LENGTH) }).strict();

const databaseSchema = z.object({ databaseId: z.string().min(1).max(MAX_ID_LENGTH) }).strict();

const pageContentSchema = z.object({
  blockId: z.string().min(1).max(MAX_ID_LENGTH),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  startCursor: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict();

const appendContentSchema = z.object({
  blockId: z.string().min(1).max(MAX_ID_LENGTH),
  children: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_APPEND_BLOCKS),
}).strict();

const archiveSchema = z.object({ pageId: z.string().min(1).max(MAX_ID_LENGTH) }).strict();

const usersSchema = z.object({
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  startCursor: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict();

const commentsSchema = z.object({
  blockId: z.string().min(1).max(MAX_ID_LENGTH),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  startCursor: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict();

const commentAddSchema = z.object({
  pageId: z.string().min(1).max(MAX_ID_LENGTH),
  discussionId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  richText: z.string().min(1).max(MAX_COMMENT_LENGTH),
}).strict();

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

/** The allowlisted database a page currently sits in, re-read from the page so
 * a stale read can never authorize a write. Undefined means the page's parent
 * is not an allowlisted database (or is a page), so the write is refused. */
async function allowedParentDatabaseId(
  accessToken: string,
  pageId: string,
  allowed: readonly string[],
  fetcher: typeof fetch | undefined,
): Promise<string | undefined> {
  const page = await notionRequest<NotionPage>({ accessToken, path: `/pages/${pageId}`, fetcher });
  const parentId = typeof page.parent?.database_id === "string" ? normalizeNotionId(page.parent.database_id) : undefined;
  return parentId && allowed.includes(parentId) ? parentId : undefined;
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

/** A database's schema, bounded and flat: property names, their types, and
 * the option names a select/status property already offers — so an agent
 * reuses existing options instead of minting stray ones. */
function databaseSummary(database: { id?: unknown; title?: unknown; properties?: unknown }): Record<string, unknown> | undefined {
  if (typeof database.id !== "string" || !database.properties || typeof database.properties !== "object") return undefined;
  const properties: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(database.properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const prop = raw as Record<string, unknown>;
    const type = typeof prop.type === "string" ? prop.type : "unknown";
    const detail = prop[type] as { options?: unknown } | undefined;
    const options = Array.isArray(detail?.options)
      ? detail.options
        .map((option) => (option && typeof option === "object" ? (option as { name?: unknown }).name : undefined))
        .filter((option): option is string => typeof option === "string")
      : undefined;
    properties[name] = { id: typeof prop.id === "string" ? prop.id : undefined, type, ...(options ? { options } : {}) };
  }
  return { id: database.id, title: richTextToPlain(database.title).slice(0, 200), properties };
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Plain text of one block, for the common text-bearing types. */
function blockText(block: Record<string, unknown>): string | undefined {
  if (typeof block.type !== "string") return undefined;
  const detail = block[block.type] as Record<string, unknown> | undefined;
  if (!detail) return undefined;
  if (Array.isArray(detail.rich_text)) {
    const text = richTextToPlain(detail.rich_text).trim();
    if (text) return bounded(text, MAX_BLOCK_TEXT);
  }
  if (Array.isArray(detail.cells)) {
    const text = detail.cells
      .map((cell) => (Array.isArray(cell) ? richTextToPlain(cell).trim() : ""))
      .join(" | ")
      .trim();
    if (text) return bounded(text, MAX_BLOCK_TEXT);
  }
  if (typeof detail.title === "string" && detail.title) return bounded(detail.title, MAX_BLOCK_TEXT);
  if (Array.isArray(detail.caption)) {
    const text = richTextToPlain(detail.caption).trim();
    if (text) return bounded(text, MAX_BLOCK_TEXT);
  }
  if (typeof detail.url === "string" && detail.url) return bounded(detail.url, MAX_BLOCK_TEXT);
  return undefined;
}

function blockSummary(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof block.id !== "string" || typeof block.type !== "string") return undefined;
  const text = blockText(block);
  return {
    id: block.id,
    type: block.type,
    ...(text ? { text } : {}),
    ...(block.has_children === true ? { hasChildren: true } : {}),
  };
}

function userSummary(user: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof user.id !== "string") return undefined;
  const person = user.person as Record<string, unknown> | undefined;
  return {
    id: user.id,
    type: typeof user.type === "string" ? user.type : "unknown",
    ...(typeof user.name === "string" && user.name ? { name: bounded(user.name, 200) } : {}),
    ...(person && typeof person.email === "string" ? { email: bounded(person.email, 320) } : {}),
  };
}

function commentSummary(comment: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof comment.id !== "string") return undefined;
  const by = comment.created_by as Record<string, unknown> | undefined;
  return {
    id: comment.id,
    ...(typeof comment.discussion_id === "string" ? { discussionId: comment.discussion_id } : {}),
    text: bounded(Array.isArray(comment.rich_text) ? richTextToPlain(comment.rich_text).trim() : "", MAX_COMMENT_LENGTH),
    ...(by && typeof by.id === "string" ? { createdBy: by.id } : {}),
  };
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

  if (pathname === INTERNAL_NOTION_DATABASE_GET) {
    const parsed = databaseSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.databaseId)) {
      jsonResponse(res, 400, { error: "invalid Notion database id" });
      return;
    }
    const database = await notionRequest<{ id?: unknown; title?: unknown; properties?: unknown }>({
      accessToken,
      path: `/databases/${parsed.data.databaseId}`,
      fetcher,
    });
    const summary = databaseSummary(database);
    if (!summary) {
      jsonResponse(res, 502, { error: "the Notion database schema could not be read" });
      return;
    }
    jsonResponse(res, 200, { database: summary });
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

  if (pathname === INTERNAL_NOTION_PAGE_CONTENT) {
    const parsed = pageContentSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.blockId)) {
      jsonResponse(res, 400, { error: "invalid Notion block id" });
      return;
    }
    const params = new URLSearchParams();
    if (parsed.data.pageSize) params.set("page_size", String(parsed.data.pageSize));
    if (parsed.data.startCursor) params.set("start_cursor", parsed.data.startCursor);
    const raw = await notionRequest<{ results?: unknown[]; has_more?: unknown; next_cursor?: unknown }>({
      accessToken,
      path: `/blocks/${parsed.data.blockId}/children${params.size ? `?${params.toString()}` : ""}`,
      fetcher,
    });
    const blocks = (raw.results ?? [])
      .map((item) => (item && typeof item === "object" ? blockSummary(item as Record<string, unknown>) : undefined))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    jsonResponse(res, 200, {
      blocks,
      hasMore: raw.has_more === true,
      ...(typeof raw.next_cursor === "string" ? { nextCursor: raw.next_cursor } : {}),
    });
    return;
  }

  if (pathname === INTERNAL_NOTION_USERS) {
    const parsed = usersSchema.safeParse(body);
    if (!parsed.success) {
      jsonResponse(res, 400, { error: "invalid Notion users request" });
      return;
    }
    const params = new URLSearchParams();
    if (parsed.data.pageSize) params.set("page_size", String(parsed.data.pageSize));
    if (parsed.data.startCursor) params.set("start_cursor", parsed.data.startCursor);
    try {
      const raw = await notionRequest<{ results?: unknown[]; has_more?: unknown; next_cursor?: unknown }>({
        accessToken,
        path: `/users${params.size ? `?${params.toString()}` : ""}`,
        fetcher,
      });
      const users = (raw.results ?? [])
        .map((item) => (item && typeof item === "object" ? userSummary(item as Record<string, unknown>) : undefined))
        .filter((item): item is Record<string, unknown> => item !== undefined);
      jsonResponse(res, 200, {
        users,
        hasMore: raw.has_more === true,
        ...(typeof raw.next_cursor === "string" ? { nextCursor: raw.next_cursor } : {}),
      });
    } catch (error) {
      // Listing users needs the integration's user-information capability,
      // which an operator may not have granted. That is not fatal: report it
      // honestly and let the caller continue without user data.
      if (error instanceof NotionApiError && (error.status === 400 || error.status === 401 || error.status === 403)) {
        jsonResponse(res, 200, { users: [], warning: "the Notion connection cannot list users" });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === INTERNAL_NOTION_COMMENTS) {
    const parsed = commentsSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.blockId)) {
      jsonResponse(res, 400, { error: "invalid Notion comments request" });
      return;
    }
    const params = new URLSearchParams({ block_id: parsed.data.blockId });
    if (parsed.data.pageSize) params.set("page_size", String(parsed.data.pageSize));
    if (parsed.data.startCursor) params.set("start_cursor", parsed.data.startCursor);
    try {
      const raw = await notionRequest<{ results?: unknown[]; has_more?: unknown; next_cursor?: unknown }>({
        accessToken,
        path: `/comments?${params.toString()}`,
        fetcher,
      });
      const comments = (raw.results ?? [])
        .map((item) => (item && typeof item === "object" ? commentSummary(item as Record<string, unknown>) : undefined))
        .filter((item): item is Record<string, unknown> => item !== undefined);
      jsonResponse(res, 200, {
        comments,
        hasMore: raw.has_more === true,
        ...(typeof raw.next_cursor === "string" ? { nextCursor: raw.next_cursor } : {}),
      });
    } catch (error) {
      // Reading comments needs the integration's comment capability, which an
      // operator may not have granted. Not fatal: report it and continue.
      if (error instanceof NotionApiError && (error.status === 401 || error.status === 403)) {
        jsonResponse(res, 200, { comments: [], warning: "the Notion connection cannot read comments" });
        return;
      }
      throw error;
    }
    return;
  }

  if (!NOTION_WRITE_AGENTS.has(agent)) {
    jsonResponse(res, 403, { error: "this agent may not write to Notion" });
    return;
  }

  if (pathname === INTERNAL_NOTION_APPEND_CONTENT) {
    const parsed = appendContentSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.blockId) || !boundedJsonSize(parsed.data.children, MAX_APPEND_BYTES)) {
      jsonResponse(res, 400, { error: "invalid Notion content append" });
      return;
    }
    if (!(await allowedParentDatabaseId(accessToken, parsed.data.blockId, options.allowedDatabaseIds, fetcher))) {
      jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
      return;
    }
    const raw = await notionRequest<{ results?: unknown[] }>({
      accessToken,
      path: `/blocks/${parsed.data.blockId}/children`,
      method: "PATCH",
      body: { children: parsed.data.children },
      fetcher,
    });
    const blocks = (raw.results ?? [])
      .map((item) => (item && typeof item === "object" ? blockSummary(item as Record<string, unknown>) : undefined))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    jsonResponse(res, 200, { appended: blocks.length, blocks });
    return;
  }

  if (pathname === INTERNAL_NOTION_ARCHIVE) {
    const parsed = archiveSchema.safeParse(body);
    if (!parsed.success || !normalizeNotionId(parsed.data.pageId)) {
      jsonResponse(res, 400, { error: "invalid Notion archive request" });
      return;
    }
    if (!(await allowedParentDatabaseId(accessToken, parsed.data.pageId, options.allowedDatabaseIds, fetcher))) {
      jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
      return;
    }
    const archived = await notionRequest<NotionPage>({
      accessToken,
      path: `/pages/${parsed.data.pageId}`,
      method: "PATCH",
      body: { archived: true },
      fetcher,
    });
    if (typeof archived.id !== "string") {
      jsonResponse(res, 502, { error: "the Notion request was refused" });
      return;
    }
    jsonResponse(res, 200, { page: { id: archived.id, archived: true } });
    return;
  }

  if (pathname === INTERNAL_NOTION_COMMENT_ADD) {
    const parsed = commentAddSchema.safeParse(body);
    const discussionId = parsed.success && parsed.data.discussionId ? normalizeNotionId(parsed.data.discussionId) : undefined;
    if (!parsed.success || !normalizeNotionId(parsed.data.pageId) || (parsed.data.discussionId && !discussionId)) {
      jsonResponse(res, 400, { error: "invalid Notion comment" });
      return;
    }
    if (!(await allowedParentDatabaseId(accessToken, parsed.data.pageId, options.allowedDatabaseIds, fetcher))) {
      jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
      return;
    }
    if (discussionId) {
      let cursor: string | undefined;
      let belongs = false;
      for (let pages = 0; pages < 20 && !belongs; pages += 1) {
        const params = new URLSearchParams({ block_id: parsed.data.pageId, page_size: "100" });
        if (cursor) params.set("start_cursor", cursor);
        let listed: { results?: unknown[]; has_more?: unknown; next_cursor?: unknown };
        try {
          listed = await notionRequest<{ results?: unknown[]; has_more?: unknown; next_cursor?: unknown }>({
            accessToken,
            path: `/comments?${params.toString()}`,
            fetcher,
          });
        } catch {
          jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
          return;
        }
        for (const item of listed.results ?? []) {
          const raw = item && typeof item === "object" ? (item as Record<string, unknown>).discussion_id : undefined;
          if (typeof raw === "string" && normalizeNotionId(raw) === discussionId) {
            belongs = true;
            break;
          }
        }
        if (listed.has_more === true && typeof listed.next_cursor === "string") cursor = listed.next_cursor;
        else break;
      }
      if (!belongs) {
        jsonResponse(res, 403, { error: "writes to this Notion database are not permitted" });
        return;
      }
    }
    const parent = discussionId
      ? { discussion_id: parsed.data.discussionId }
      : { page_id: parsed.data.pageId };
    const created = await notionRequest<{ id?: unknown }>({
      accessToken,
      path: "/comments",
      method: "POST",
      body: { parent, rich_text: [{ type: "text", text: { content: parsed.data.richText } }] },
      fetcher,
    });
    if (typeof created.id !== "string") {
      jsonResponse(res, 502, { error: "the Notion request was refused" });
      return;
    }
    jsonResponse(res, 200, { comment: { id: created.id } });
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
    const existingProp = current.properties?.[parsed.data.property];
    const existingFiles: Array<Record<string, unknown>> = [];
    if (existingProp && typeof existingProp === "object") {
      const filesValue = (existingProp as Record<string, unknown>).files;
      if (Array.isArray(filesValue)) {
        for (const entry of filesValue) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          const name = typeof record.name === "string" ? record.name : file.filename;
          if (record.type === "external") {
            const external = record.external as Record<string, unknown> | undefined;
            if (external && typeof external.url === "string" && external.url) {
              existingFiles.push({ name, type: "external", external: { url: external.url } });
            }
          } else if (record.type === "file_upload") {
            const upload = record.file_upload as Record<string, unknown> | undefined;
            if (upload && typeof upload.id === "string" && upload.id) {
              existingFiles.push({ name, type: "file_upload", file_upload: { id: upload.id } });
            }
          } else if (record.type === "file") {
            const hosted = record.file as Record<string, unknown> | undefined;
            if (hosted && typeof hosted.url === "string" && hosted.url) {
              existingFiles.push({ name, type: "external", external: { url: hosted.url } });
            }
          }
        }
      }
    }
    const patched = await notionRequest<NotionPage>({
      accessToken,
      path: `/pages/${parsed.data.pageId}`,
      method: "PATCH",
      version: NOTION_FILE_API_VERSION,
      body: {
        properties: {
          [parsed.data.property]: {
            files: [...existingFiles, { name: file.filename, type: "file_upload", file_upload: { id: uploadId } }],
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
