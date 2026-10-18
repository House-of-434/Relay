/** Minimal Notion REST gateway for the BFF.
 *
 * The BFF owns the only copies of user access tokens: it exchanges OAuth codes
 * here and attaches `Authorization: Bearer` per request from the verified
 * actor's own connection. Tokens never leave this process.
 *
 * Pinned API version: 2022-06-28 (long-stable; covers search/pages/databases
 * used by the Dealflow connector). Revisit only after a live probe against the
 * copy database proves the newer data-source behavior is needed. */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2022-06-28";
export const NOTION_OAUTH_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

const MAX_TOKEN_LENGTH = 16_384;
const MAX_WORKSPACE_FIELD_LENGTH = 512;

export class NotionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
  }
}

export interface NotionOAuthExchange {
  accessToken: string;
  workspaceId: string;
  workspaceName?: string;
  notionUserId?: string;
  ownerEmail?: string;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function errorMessage(status: number, body: unknown): string {
  const message = body && typeof body === "object" && Reflect.get(body, "message");
  if (typeof message === "string" && message.length > 0 && message.length <= 300) return message;
  if (status === 401 || status === 403) return "Notion authorization was refused";
  if (status === 404) return "the Notion database or page was not found";
  if (status === 429) return "Notion rate limit reached";
  return "the Notion request was refused";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Exchange an OAuth authorization code for a workspace access token. */
export async function exchangeNotionToken(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
}): Promise<NotionOAuthExchange> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(new URL(NOTION_OAUTH_TOKEN_URL), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
  } catch {
    throw new NotionApiError(502, "the Notion token exchange failed");
  }
  const body = await readJson(response);
  if (!response.ok) throw new NotionApiError(response.status, errorMessage(response.status, body));
  const record = (body ?? {}) as Record<string, unknown>;
  const accessToken = boundedString(record.access_token, MAX_TOKEN_LENGTH);
  const workspaceId = boundedString(record.workspace_id, MAX_WORKSPACE_FIELD_LENGTH);
  if (!accessToken || !workspaceId) throw new NotionApiError(502, "the Notion token exchange failed");
  const owner = record.owner as Record<string, unknown> | undefined;
  const user = owner && typeof owner === "object" ? owner.user as Record<string, unknown> | undefined : undefined;
  const person = user && typeof user === "object" ? user.person as Record<string, unknown> | undefined : undefined;
  return {
    accessToken,
    workspaceId,
    workspaceName: boundedString(record.workspace_name, MAX_WORKSPACE_FIELD_LENGTH),
    notionUserId: boundedString(record.bot_id, MAX_WORKSPACE_FIELD_LENGTH) ?? boundedString(user?.id, MAX_WORKSPACE_FIELD_LENGTH),
    ownerEmail: person ? boundedString(person.email, MAX_WORKSPACE_FIELD_LENGTH) : undefined,
  };
}

/** Endpoints added after the data API's pinned version — file uploads and
 * page moves — need a newer Notion-Version. Pin it once so those calls move
 * together, kept separate from NOTION_API_VERSION so page/database behavior
 * the rest of the connector relies on does not shift underneath it. */
export const NOTION_NEW_API_VERSION = "2025-09-03";
export const NOTION_FILE_API_VERSION = NOTION_NEW_API_VERSION;

/** One authenticated Notion REST call. */
export async function notionRequest<T>(input: {
  accessToken: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Overrides the pinned data API version for endpoints that need a newer
   * one (file uploads). */
  version?: string;
  fetcher?: typeof fetch;
}): Promise<T> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    // input.path is absolute ("/search"), which would discard the /v1 base
    // under URL resolution — resolve it as relative instead.
    response = await fetcher(new URL(input.path.replace(/^\//, ""), `${NOTION_API_BASE}/`), {
      method: input.method ?? "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "Notion-Version": input.version ?? NOTION_API_VERSION,
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch {
    throw new NotionApiError(502, "the Notion request failed");
  }
  const body = await readJson(response);
  if (!response.ok) throw new NotionApiError(response.status, errorMessage(response.status, body));
  return body as T;
}

/** Upload one file's bytes to Notion and return the file-upload id, ready to
 * reference as `{ type: "file_upload", file_upload: { id } }` on a files
 * property. Three calls, exactly as the API requires: create the request, send
 * the bytes to the signed upload URL, then reference the id. */
export async function uploadNotionFile(input: {
  accessToken: string;
  filename: string;
  mimeType: string;
  /** Standard base64 file bytes. */
  data: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const created = await notionRequest<{ id?: unknown; upload_url?: unknown; complete_url?: unknown }>({
    accessToken: input.accessToken,
    path: "/file_uploads",
    method: "POST",
    version: NOTION_FILE_API_VERSION,
    body: { filename: input.filename, content_type: input.mimeType },
    fetcher,
  });
  const id = typeof created.id === "string" ? created.id : undefined;
  const uploadUrl = typeof created.upload_url === "string" ? created.upload_url : undefined;
  if (!id || !uploadUrl) throw new NotionApiError(502, "the Notion file upload could not be created");

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.data, "base64");
  } catch {
    throw new NotionApiError(400, "invalid file bytes");
  }
  if (bytes.length === 0) throw new NotionApiError(400, "empty file");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: input.mimeType }), input.filename);
  let sent: Response;
  try {
    sent = await fetcher(new URL(uploadUrl), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${input.accessToken}`, "Notion-Version": NOTION_FILE_API_VERSION },
      body: form,
    });
  } catch {
    throw new NotionApiError(502, "the Notion file upload failed");
  }
  if (!sent.ok) throw new NotionApiError(sent.status, errorMessage(sent.status, await readJson(sent)));
  return id;
}

/** Normalize a database/page id for comparison: Notion accepts dashed or
 * undashed ids; the allowlist compares the 32-hex form. */
export function normalizeNotionId(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(compact) ? compact : undefined;
}
