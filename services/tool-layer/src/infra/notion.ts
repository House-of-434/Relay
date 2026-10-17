/** Notion connector client.
 *
 * The Tool Layer never holds a Notion credential. Notion access is
 * authenticated per user through the BFF: the client authorizes the operation,
 * then asks the BFF to run it with the signed actor assertion it already
 * verified. The BFF attaches the actor's own workspace token and enforces the
 * writable-database allowlist — never from these arguments. */

export const NOTION_INTERNAL_PATHS = {
  search: "/api/internal/notion/search",
  get: "/api/internal/notion/get",
  query: "/api/internal/notion/query",
  create: "/api/internal/notion/create",
  update: "/api/internal/notion/update",
} as const;

export class NotionRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionRequestError";
    this.status = status;
  }
}

export interface RelayNotionClientOptions {
  bffInternalUrl: string;
  capability: string | undefined;
  fetcher?: typeof fetch;
}

export interface NotionSearchResult {
  id: string;
  object: string;
  title?: string;
  url?: string;
}

export interface NotionPageSummary {
  id: string;
  url?: string;
  properties: Record<string, unknown>;
}

export class RelayNotionClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: RelayNotionClientOptions) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async call<Result>(path: string, actorAssertion: string, payload: unknown): Promise<Result> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new NotionRequestError(503, "the Notion connector service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new NotionRequestError(502, "the Notion connector service is unreachable");
    }
    if (!response.ok) throw new NotionRequestError(response.status, await safeErrorMessage(response));
    return await response.json() as Result;
  }

  search(actorAssertion: string, input: { query: string; pageSize?: number }) {
    return this.call<{ results: NotionSearchResult[] }>(NOTION_INTERNAL_PATHS.search, actorAssertion, input);
  }

  getPage(actorAssertion: string, input: { pageId: string }) {
    return this.call<{ page: NotionPageSummary }>(NOTION_INTERNAL_PATHS.get, actorAssertion, input);
  }

  queryDatabase(actorAssertion: string, input: {
    databaseId: string;
    filter?: Record<string, unknown>;
    sorts?: Array<Record<string, unknown>>;
    pageSize?: number;
    startCursor?: string;
  }) {
    return this.call<{ rows: NotionPageSummary[]; hasMore: boolean; nextCursor?: string }>(
      NOTION_INTERNAL_PATHS.query,
      actorAssertion,
      input,
    );
  }

  createPage(actorAssertion: string, input: { databaseId: string; properties: Record<string, unknown> }) {
    return this.call<{ page: { id: string; url?: string } }>(NOTION_INTERNAL_PATHS.create, actorAssertion, input);
  }

  updatePage(actorAssertion: string, input: { pageId: string; properties: Record<string, unknown> }) {
    return this.call<{ page: { id: string; url?: string } }>(NOTION_INTERNAL_PATHS.update, actorAssertion, input);
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
      ? body.error
      : "the Notion request was refused";
  } catch {
    return "the Notion request was refused";
  }
}
