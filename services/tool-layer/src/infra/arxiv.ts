/** arXiv connector: public paper search and retrieval over the official
 * export API. No user login, no credential. Results are normalized to the
 * shared ConnectorResult shape; arXiv's Atom-specific fields stay here.
 *
 * arXiv asks callers to be gentle: requests are serialized with a minimum gap
 * and a descriptive User-Agent is sent on every call. */

import { boundedText, isHttpUrl, type ConnectorResult } from "../domain/connector-result.js";
import { fetchWithRetry } from "./http.js";
import { SerialGate } from "./throttle.js";

export const ARXIV_EXPORT_URL = "https://export.arxiv.org/api/query";
export const ARXIV_MIN_INTERVAL_MS = 3_000;
const ARXIV_DEFAULT_LIMIT = 10;
const ARXIV_MAX_LIMIT = 50;
const ABSTRACT_MAX = 3_000;

export interface ArxivSearchInput {
  query: string;
  title?: string;
  author?: string;
  category?: string;
  /** Inclusive lower bound, YYYY-MM-DD. */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  to?: string;
  sort?: "relevance" | "submitted" | "updated";
  limit?: number;
}

export interface ArxivProviderOptions {
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  gate?: SerialGate;
}

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published?: string;
  updated?: string;
  authors: string[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function firstTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXml(match[1]!).replace(/\s+/g, " ").trim() : undefined;
}

function canonicalId(rawId: string): string {
  const withoutUrl = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
  return withoutUrl.replace(/v\d+$/, "");
}

export function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const rawId = firstTag(block, "id");
    const title = firstTag(block, "title");
    if (!rawId || !title) continue;
    const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((match) => decodeXml(match[1]!).replace(/\s+/g, " ").trim())
      .filter((name) => name.length > 0);
    entries.push({
      id: canonicalId(rawId),
      title,
      summary: firstTag(block, "summary") ?? "",
      published: firstTag(block, "published"),
      updated: firstTag(block, "updated"),
      authors,
    });
  }
  return entries;
}

function toResult(entry: ArxivEntry): ConnectorResult {
  return {
    source: "arxiv",
    sourceId: entry.id,
    canonicalUrl: `https://arxiv.org/abs/${entry.id}`,
    title: entry.title,
    publishedAt: entry.published,
    updatedAt: entry.updated,
    authors: entry.authors.length > 0 ? entry.authors : undefined,
    content: boundedText(entry.summary, ABSTRACT_MAX),
    metadata: { provider: "arxiv" },
  };
}

function daysToArxivDate(value: string | undefined, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("arxiv date filters must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error("arxiv date filters must use YYYY-MM-DD");
  }
  return `${match[1]}${match[2]}${match[3]}${endOfDay ? "2359" : "0000"}`;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function phraseTerm(value: string): string {
  return `"${escapeQuoted(value)}"`;
}

function fieldTerm(value: string): string {
  const escaped = escapeQuoted(value);
  return /[\s":]/.test(value) ? `"${escaped}"` : escaped;
}

function buildSearchQuery(input: ArxivSearchInput): string {
  const terms: string[] = [];
  const query = input.query.trim();
  if (query.length > 0) terms.push(`all:${phraseTerm(query)}`);
  if (input.title?.trim()) terms.push(`ti:${phraseTerm(input.title.trim())}`);
  if (input.author?.trim()) terms.push(`au:${phraseTerm(input.author.trim())}`);
  if (input.category?.trim()) terms.push(`cat:${fieldTerm(input.category.trim())}`);
  const from = daysToArxivDate(input.from, false);
  const to = daysToArxivDate(input.to, true);
  if (from || to) terms.push(`submittedDate:[${from ?? "000000000000"} TO ${to ?? "999912312359"}]`);
  if (terms.length === 0) throw new Error("arxiv_search requires a query, title, author, category, or date range");
  return terms.join(" AND ");
}

const SORT_BY: Record<NonNullable<ArxivSearchInput["sort"]>, string> = {
  relevance: "relevance",
  submitted: "submittedDate",
  updated: "lastUpdatedDate",
};

export class ArxivProvider {
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number | undefined;
  private readonly fetcher: typeof fetch | undefined;
  private readonly gate: SerialGate;

  constructor(options: ArxivProviderOptions) {
    this.userAgent = options.userAgent;
    this.baseUrl = options.baseUrl ?? ARXIV_EXPORT_URL;
    this.timeoutMs = options.timeoutMs;
    this.fetcher = options.fetcher;
    this.gate = options.gate ?? new SerialGate(ARXIV_MIN_INTERVAL_MS);
  }

  async search(input: ArxivSearchInput): Promise<ConnectorResult[]> {
    const limit = Math.min(Math.max(input.limit ?? ARXIV_DEFAULT_LIMIT, 1), ARXIV_MAX_LIMIT);
    const params = new URLSearchParams({
      search_query: buildSearchQuery(input),
      start: "0",
      max_results: String(limit),
      sortBy: SORT_BY[input.sort ?? "relevance"],
      sortOrder: "descending",
    });
    const xml = await this.request(`${this.baseUrl}?${params.toString()}`);
    return parseArxivFeed(xml).map(toResult);
  }

  async get(id: string): Promise<ConnectorResult | undefined> {
    const normalized = canonicalId(id.trim());
    if (normalized.length === 0) throw new Error("arxiv_get requires a paper id");
    const params = new URLSearchParams({ id_list: normalized, max_results: "1" });
    const xml = await this.request(`${this.baseUrl}?${params.toString()}`);
    const [entry] = parseArxivFeed(xml);
    return entry ? toResult(entry) : undefined;
  }

  private async request(url: string): Promise<string> {
    if (!isHttpUrl(url)) throw new Error("arxiv request URL is invalid");
    return this.gate.run(async () => {
      const response = await fetchWithRetry(url, {
        timeoutMs: this.timeoutMs,
        fetcher: this.fetcher,
        headers: { "user-agent": this.userAgent, accept: "application/atom+xml" },
      });
      return response.text;
    });
  }
}
