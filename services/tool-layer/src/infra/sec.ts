/** SEC EDGAR connector: public company filings and XBRL facts over the
 * official data APIs. No user login and no API key for public data.
 *
 * SEC's fair-access policy needs a declared User-Agent with contact
 * information and throttled request rates, so every call carries the operator
 * User-Agent and passes through a token-bucket limiter. `company_tickers.json`
 * and submissions/facts responses are cached in memory to keep repeat lookups
 * off the wire. The User-Agent is required; the connector fails closed if it
 * is not configured. */

import { boundedText, type ConnectorResult } from "../domain/connector-result.js";
import { fetchJson, fetchWithRetry } from "./http.js";
import { RateLimiter, TtlCache } from "./throttle.js";

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions";
export const SEC_COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
export const SEC_FULL_TEXT_URL = "https://efts.sec.gov/LATEST/search-index";
export const SEC_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
export const SEC_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames";
export const SEC_RATE_PER_SECOND = 10;

const TICKERS_TTL_MS = 12 * 60 * 60 * 1000;
const SUBMISSIONS_TTL_MS = 10 * 60 * 1000;
const FACTS_TTL_MS = 10 * 60 * 1000;
const SUMMARY_MAX = 500;
const FULL_TEXT_DEFAULT_LIMIT = 10;
const FULL_TEXT_MAX_LIMIT = 100;
const FILING_TEXT_MAX = 20_000;
/** A 10-K's HTML routinely runs several MB, so the filing reader gets a larger
 * (still bounded) fetch cap than the 2 MB JSON default. */
const FILING_FETCH_MAX_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY_PAGES = 5;
const FRAMES_DEFAULT_LIMIT = 50;
const FRAMES_MAX_LIMIT = 200;
const COMPARE_MAX_COMPANIES = 10;
const COMPARE_DEFAULT_VALUES = 8;
const COMPARE_MAX_VALUES = 40;
const FACTS_MAX_RESULTS = 50;
/** `companyfacts` for a large filer runs to several MB, well over the 2 MB JSON
 * default; keep it bounded but large enough to read. */
const FACTS_FETCH_MAX_BYTES = 32 * 1024 * 1024;
const FRAMES_FETCH_MAX_BYTES = 16 * 1024 * 1024;

export interface SecProviderOptions {
  /** Declared fair-access identity, e.g. "Relay Research (ops@example.com)". */
  userAgent: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecCompany {
  cik: number;
  ticker?: string;
  title?: string;
}

interface SecFilingArrays {
  accessionNumber?: unknown;
  filingDate?: unknown;
  form?: unknown;
  primaryDocument?: unknown;
  reportDate?: unknown;
  primaryDocDescription?: unknown;
}

interface SecSubmissions {
  name?: unknown;
  filings?: { recent?: SecFilingArrays; files?: unknown };
}

export interface SecSearchFilingsInput {
  company: string;
  formType?: string;
  from?: string;
  to?: string;
  /** Also scan EDGAR's older filing pages when the recent window is not enough. */
  includeHistory?: boolean;
  limit?: number;
}

export interface SecFullTextSearchInput {
  query: string;
  /** Comma-separated form types, e.g. "10-K,10-Q". */
  forms?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SecGetFilingInput {
  company: string;
  /** Accession number with dashes, e.g. 0000320193-24-000123. */
  accessionNumber: string;
  /** Document file name; defaults to the filing's primary document. */
  document?: string;
}

export interface SecCompanyFactsInput {
  company: string;
  tag?: string;
  taxonomy?: string;
  unit?: string;
  /** Only values whose period ends on this date (YYYY-MM-DD). */
  period?: string;
}

export interface SecFramesInput {
  tag: string;
  unit: string;
  /** Calendar year of the frame. */
  year: number;
  /** Calendar quarter 1-4; omit for an annual frame. */
  quarter?: number;
  /** Instantaneous (balance-sheet) frame; duration frames are the default. */
  instant?: boolean;
  taxonomy?: string;
  limit?: number;
}

export interface SecCompareFactsInput {
  companies: string[];
  tag: string;
  taxonomy?: string;
  unit?: string;
  /** Only values whose period ends on this date (YYYY-MM-DD). */
  period?: string;
  limit?: number;
}

interface SecFrameEntry {
  cik?: unknown;
  entityName?: unknown;
  end?: unknown;
  val?: unknown;
  accn?: unknown;
  loc?: unknown;
}

interface SecFramesResponse {
  data?: SecFrameEntry[];
}

interface SecFullTextHit {
  _id?: unknown;
  _source?: {
    ciks?: unknown;
    display_names?: unknown;
    form?: unknown;
    file_date?: unknown;
    adsh?: unknown;
    file_description?: unknown;
    file_type?: unknown;
  };
}

interface SecFullTextResponse {
  hits?: { hits?: SecFullTextHit[] };
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function padCik(cik: number): string {
  return String(cik).padStart(10, "0");
}

/** CIK ints from the ticker file; submissions URLs use the zero-padded form. */
export function normalizeCik(input: string): number | undefined {
  const digits = input.replace(/^0+/, "");
  if (!/^\d{1,10}$/.test(digits)) return undefined;
  return Number(digits);
}

function assertCalendarDate(value: string, field: string, tool = "sec_search_filings"): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${tool} ${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`${tool} ${field} must use YYYY-MM-DD`);
  }
}

export class SecProvider {
  private readonly userAgent: string;
  private readonly timeoutMs: number | undefined;
  private readonly fetcher: typeof fetch | undefined;
  private readonly limiter = new RateLimiter(SEC_RATE_PER_SECOND);
  private readonly tickers = new TtlCache<TickerRow[]>(TICKERS_TTL_MS, 4);
  private readonly submissions = new TtlCache<SecSubmissions>(SUBMISSIONS_TTL_MS);
  private readonly history = new TtlCache<SecFilingArrays>(SUBMISSIONS_TTL_MS);
  private readonly facts = new TtlCache<unknown>(FACTS_TTL_MS);

  constructor(options: SecProviderOptions) {
    if (!options.userAgent || options.userAgent.trim().length === 0) {
      throw new Error("SEC connector requires RELAY_SEC_USER_AGENT (a declared User-Agent with contact information)");
    }
    this.userAgent = options.userAgent.trim();
    this.timeoutMs = options.timeoutMs;
    this.fetcher = options.fetcher;
  }

  private headers(): Record<string, string> {
    return { "user-agent": this.userAgent, accept: "application/json" };
  }

  private async getJson<T>(url: string, maxBytes?: number): Promise<T> {
    await this.limiter.acquire();
    return fetchJson<T>(url, { timeoutMs: this.timeoutMs, fetcher: this.fetcher, headers: this.headers(), maxBytes });
  }

  private async tickerRows(): Promise<TickerRow[]> {
    return this.tickers.getOrSet("all", async () => {
      const raw = await this.getJson<Record<string, TickerRow>>(SEC_TICKERS_URL);
      return Object.values(raw).filter((row) => row && typeof row.cik_str === "number" && typeof row.ticker === "string" && typeof row.title === "string");
    });
  }

  /** Resolve a name or ticker to companies. A bare integer is treated as a CIK. */
  async resolveCompany(query: string): Promise<SecCompany[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) throw new Error("sec_resolve_company requires a company name or ticker");
    const asCik = normalizeCik(trimmed);
    if (asCik !== undefined && /^\d+$/.test(trimmed)) {
      return [{ cik: asCik }];
    }
    const rows = await this.tickerRows();
    const needle = trimmed.toLowerCase();
    const exactTicker = rows.filter((row) => row.ticker.toLowerCase() === needle);
    const matches = exactTicker.length > 0
      ? exactTicker
      : rows.filter((row) => row.title.toLowerCase().includes(needle));
    return matches.slice(0, 10).map((row) => ({
      cik: row.cik_str,
      ticker: row.ticker,
      title: row.title,
    }));
  }

  private async resolveCik(company: string): Promise<number> {
    const matches = await this.resolveCompany(company);
    if (matches.length === 0) throw new Error(`no SEC company matched "${company}"`);
    if (matches.length > 1) {
      const named = matches.map((m) => m.ticker ?? String(m.cik)).join(", ");
      throw new Error(`"${company}" matched several companies (${named}); use a ticker or CIK`);
    }
    return matches[0]!.cik;
  }

  private async submissionsFor(cik: number): Promise<SecSubmissions> {
    return this.submissions.getOrSet(padCik(cik), () =>
      this.getJson<SecSubmissions>(`${SEC_SUBMISSIONS_URL}/CIK${padCik(cik)}.json`));
  }

  async searchFilings(input: SecSearchFilingsInput): Promise<ConnectorResult[]> {
    const cik = await this.resolveCik(input.company);
    const submissions = await this.submissionsFor(cik);
    const formFilter = input.formType?.trim().toUpperCase();
    const from = input.from?.trim();
    const to = input.to?.trim();
    if (from) assertCalendarDate(from, "from");
    if (to) assertCalendarDate(to, "to");
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const filters = { formFilter, from, to, limit };
    const results: ConnectorResult[] = [];
    const recent = submissions.filings?.recent;
    if (recent) this.collectFilings(cik, recent, filters, results);
    if (input.includeHistory && results.length < limit) {
      for (const page of await this.historyPages(submissions)) {
        this.collectFilings(cik, page, filters, results);
        if (results.length >= limit) break;
      }
    }
    results.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    return results.slice(0, limit);
  }

  /** Append the filings from one submissions array that pass the filters,
   * filling `out` up to the limit. */
  private collectFilings(
    cik: number,
    arrays: SecFilingArrays,
    filters: { formFilter?: string; from?: string; to?: string; limit: number },
    out: ConnectorResult[],
  ): void {
    const count = Array.isArray(arrays.accessionNumber) ? arrays.accessionNumber.length : 0;
    for (let index = 0; index < count && out.length < filters.limit; index += 1) {
      const form = safeString((arrays.form as unknown[])?.[index]);
      const filingDate = safeString((arrays.filingDate as unknown[])?.[index]);
      const accession = safeString((arrays.accessionNumber as unknown[])?.[index]);
      if (!form || !filingDate || !accession) continue;
      if (filters.formFilter && form.toUpperCase() !== filters.formFilter) continue;
      if (filters.from && filingDate < filters.from) continue;
      if (filters.to && filingDate > filters.to) continue;
      const primaryDocument = safeString((arrays.primaryDocument as unknown[])?.[index]);
      const description = safeString((arrays.primaryDocDescription as unknown[])?.[index]);
      out.push(filingResult(cik, { form, filingDate, accession, primaryDocument, description }));
    }
  }

  /** EDGAR splits older filings out of `filings.recent` into `filings.files`
   * pages; fetch the newest pages first, bounded to keep one search cheap. */
  private async historyPages(submissions: SecSubmissions): Promise<SecFilingArrays[]> {
    const files = submissions.filings?.files;
    if (!Array.isArray(files)) return [];
    const named = files
      .map((file) => ({
        name: safeString((file as { name?: unknown })?.name),
        filingTo: safeString((file as { filingTo?: unknown })?.filingTo),
      }))
      .filter((entry): entry is { name: string; filingTo: string | undefined } => entry.name !== undefined);
    named.sort((a, b) => (b.filingTo ?? "").localeCompare(a.filingTo ?? ""));
    const pages: SecFilingArrays[] = [];
    for (const entry of named.slice(0, MAX_HISTORY_PAGES)) {
      pages.push(await this.history.getOrSet(entry.name, () =>
        this.getJson<SecFilingArrays>(`${SEC_SUBMISSIONS_URL}/${entry.name}`)));
    }
    return pages;
  }

  /** Full-text search across all EDGAR filings (the `efts.sec.gov` index). */
  async searchFullText(input: SecFullTextSearchInput): Promise<ConnectorResult[]> {
    const query = input.query.trim();
    if (query.length === 0) throw new Error("sec_search_text requires a query");
    const from = input.from?.trim();
    const to = input.to?.trim();
    if (from) assertCalendarDate(from, "from", "sec_search_text");
    if (to) assertCalendarDate(to, "to", "sec_search_text");
    const params = new URLSearchParams({ q: query });
    const forms = input.forms?.trim();
    if (forms) params.set("forms", forms.toUpperCase());
    if (from || to) {
      params.set("dateRange", "custom");
      if (from) params.set("startdt", from);
      if (to) params.set("enddt", to);
    }
    const raw = await this.getJson<SecFullTextResponse>(`${SEC_FULL_TEXT_URL}?${params.toString()}`);
    const limit = Math.min(Math.max(input.limit ?? FULL_TEXT_DEFAULT_LIMIT, 1), FULL_TEXT_MAX_LIMIT);
    const results: ConnectorResult[] = [];
    for (const hit of raw?.hits?.hits ?? []) {
      const result = fullTextResult(hit);
      if (result) results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  }

  /** Read one filing document as bounded plain text. */
  async getFiling(input: SecGetFilingInput): Promise<ConnectorResult> {
    const cik = await this.resolveCik(input.company);
    const accession = input.accessionNumber.trim();
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) {
      throw new Error("sec_get_filing requires an accession number like 0000320193-24-000123");
    }
    const document = input.document?.trim() || (await this.primaryDocument(cik, accession));
    if (!document) throw new Error(`no document found for filing ${accession}`);
    const url = `${SEC_ARCHIVES_BASE}/${cik}/${accession.replace(/-/g, "")}/${document}`;
    const body = await this.fetchDocument(url);
    const fullText = htmlToText(body);
    const text = fullText.slice(0, FILING_TEXT_MAX);
    return {
      source: "sec-edgar",
      sourceId: `${accession}:${document}`,
      canonicalUrl: url,
      title: `${accession} ${document}`,
      content: boundedText(text, FILING_TEXT_MAX),
      metadata: {
        cik,
        accessionNumber: accession,
        primaryDocument: document,
        truncated: fullText.length > FILING_TEXT_MAX,
      },
    };
  }

  private async primaryDocument(cik: number, accession: string): Promise<string | undefined> {
    const submissions = await this.submissionsFor(cik);
    const recent = this.accessionDocument(submissions.filings?.recent, accession);
    if (recent) return recent;
    for (const page of await this.historyPages(submissions)) {
      const document = this.accessionDocument(page, accession);
      if (document) return document;
    }
    return undefined;
  }

  private accessionDocument(arrays: SecFilingArrays | undefined, accession: string): string | undefined {
    if (!arrays) return undefined;
    const count = Array.isArray(arrays.accessionNumber) ? arrays.accessionNumber.length : 0;
    for (let index = 0; index < count; index += 1) {
      if (safeString((arrays.accessionNumber as unknown[])?.[index]) === accession) {
        return safeString((arrays.primaryDocument as unknown[])?.[index]);
      }
    }
    return undefined;
  }

  private async fetchDocument(url: string): Promise<string> {
    await this.limiter.acquire();
    const response = await fetchWithRetry(url, {
      timeoutMs: this.timeoutMs,
      fetcher: this.fetcher,
      maxBytes: FILING_FETCH_MAX_BYTES,
      headers: { "user-agent": this.userAgent, accept: "text/html,application/xhtml+xml,text/plain" },
    });
    const type = response.contentType.toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/.test(type)) {
      throw new Error(`the filing document is not readable text (${type})`);
    }
    return response.text;
  }

  async companyFacts(input: SecCompanyFactsInput): Promise<ConnectorResult[]> {
    const cik = await this.resolveCik(input.company);
    const facts = await this.factsFor(cik);
    const period = input.period?.trim();
    if (period) assertCalendarDate(period, "period", "sec_company_facts");
    const results: ConnectorResult[] = [];
    this.collectFacts(cik, facts, {
      taxonomy: input.taxonomy?.trim(),
      tag: input.tag?.trim(),
      unit: input.unit?.trim(),
      period,
      limit: FACTS_MAX_RESULTS,
    }, results);
    return results;
  }

  /** Compare one XBRL tag across named companies: one result per company with
   * the selected unit and period values, for like-for-like comparison. */
  async compareFacts(input: SecCompareFactsInput): Promise<ConnectorResult[]> {
    const tag = input.tag.trim();
    if (tag.length === 0) throw new Error("sec_compare_facts requires a tag");
    const companies = input.companies.map((company) => company.trim()).filter((company) => company.length > 0);
    if (companies.length < 2) throw new Error("sec_compare_facts requires at least two companies");
    if (companies.length > COMPARE_MAX_COMPANIES) {
      throw new Error(`sec_compare_facts accepts at most ${COMPARE_MAX_COMPANIES} companies`);
    }
    const period = input.period?.trim();
    if (period) assertCalendarDate(period, "period", "sec_compare_facts");
    const limit = Math.min(Math.max(input.limit ?? COMPARE_DEFAULT_VALUES, 1), COMPARE_MAX_VALUES);
    const taxonomy = input.taxonomy?.trim();
    const unit = input.unit?.trim();
    const results: ConnectorResult[] = [];
    for (const company of companies) {
      const cik = await this.resolveCik(company);
      const facts = await this.factsFor(cik);
      this.collectFacts(cik, facts, { taxonomy, tag, unit, period, limit }, results);
    }
    return results;
  }

  /** XBRL frames: one tag/unit across every filer for a calendar period. */
  async frames(input: SecFramesInput): Promise<ConnectorResult[]> {
    const tag = input.tag.trim();
    const unit = input.unit.trim();
    if (tag.length === 0 || unit.length === 0) throw new Error("sec_frames requires a tag and unit");
    const taxonomy = (input.taxonomy?.trim() || "us-gaap").toLowerCase();
    const period = framePeriod(input);
    const url = `${SEC_FRAMES_URL}/${encodeURIComponent(taxonomy)}/${encodeURIComponent(tag)}/${encodeURIComponent(unit)}/${period}.json`;
    const raw = await this.getJson<SecFramesResponse>(url, FRAMES_FETCH_MAX_BYTES);
    const limit = Math.min(Math.max(input.limit ?? FRAMES_DEFAULT_LIMIT, 1), FRAMES_MAX_LIMIT);
    const results: ConnectorResult[] = [];
    for (const entry of raw?.data ?? []) {
      const result = frameResult(taxonomy, tag, unit, period, entry);
      if (result) results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  }

  private async factsFor(cik: number): Promise<Record<string, Record<string, unknown>>> {
    const raw = await this.facts.getOrSet(padCik(cik), () =>
      this.getJson<unknown>(`${SEC_COMPANY_FACTS_URL}/CIK${padCik(cik)}.json`, FACTS_FETCH_MAX_BYTES));
    return (raw as { facts?: Record<string, Record<string, unknown>> } | null)?.facts ?? {};
  }

  private collectFacts(
    cik: number,
    facts: Record<string, Record<string, unknown>>,
    filters: { taxonomy?: string; tag?: string; unit?: string; period?: string; limit: number },
    out: ConnectorResult[],
  ): void {
    const started = out.length;
    const taxonomyNeedle = filters.taxonomy?.toLowerCase();
    const tagNeedle = filters.tag?.toLowerCase();
    const unitNeedle = filters.unit?.toLowerCase();
    for (const [taxonomyName, tags] of Object.entries(facts)) {
      if (taxonomyNeedle && taxonomyName.toLowerCase() !== taxonomyNeedle) continue;
      for (const [tagName, definition] of Object.entries(tags ?? {})) {
        if (tagNeedle && !tagName.toLowerCase().includes(tagNeedle)) continue;
        const units = (definition as { units?: Record<string, unknown[]> }).units ?? {};
        const unitNames = Object.keys(units);
        const selectedUnit = unitNeedle
          ? unitNames.find((name) => name.toLowerCase() === unitNeedle)
          : unitNames[0];
        if (!selectedUnit) continue;
        const values = filterValues(units[selectedUnit] ?? [], filters.period).filter(
          (value) => typeof (value as { val?: unknown })?.val === "number",
        );
        if (values.length === 0) continue;
        out.push(factResult(cik, taxonomyName, tagName, selectedUnit, values));
        if (out.length - started >= filters.limit) return;
      }
    }
  }
}

export function filingResult(
  cik: number,
  filing: { form: string; filingDate: string; accession: string; primaryDocument?: string; description?: string },
): ConnectorResult {
  const accessionNoDashes = filing.accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes}/`;
  return {
    source: "sec-edgar",
    sourceId: filing.accession,
    canonicalUrl: filing.primaryDocument ? `${base}${filing.primaryDocument}` : base,
    title: `${filing.form} filed ${filing.filingDate}`,
    publishedAt: filing.filingDate,
    content: boundedText(filing.description, SUMMARY_MAX),
    metadata: {
      cik,
      form: filing.form,
      accessionNumber: filing.accession,
      primaryDocument: filing.primaryDocument,
    },
  };
}

function fullTextResult(hit: SecFullTextHit): ConnectorResult | undefined {
  const id = safeString(hit._id);
  if (!id || !id.includes(":")) return undefined;
  const source = hit._source ?? {};
  const accession = safeString(source.adsh) ?? safeString(id.slice(0, id.indexOf(":")));
  const document = safeString(id.slice(id.indexOf(":") + 1));
  const ciks = Array.isArray(source.ciks) ? source.ciks.map(safeString).filter((cik): cik is string => cik !== undefined) : [];
  const cik = ciks[0] ? normalizeCik(ciks[0]) : undefined;
  if (!accession || !document || cik === undefined) return undefined;
  const form = safeString(source.form) ?? safeString(source.file_type);
  const fileDate = safeString(source.file_date);
  const displayName = Array.isArray(source.display_names)
    ? source.display_names.map(safeString).find((name): name is string => name !== undefined)
    : undefined;
  const url = `${SEC_ARCHIVES_BASE}/${cik}/${accession.replace(/-/g, "")}/${document}`;
  const title = displayName
    ? (form ? `${displayName} — ${form}` : displayName)
    : (form ? `${form} filed ${fileDate ?? ""}`.trim() : accession);
  return {
    source: "sec-edgar",
    sourceId: `${accession}:${document}`,
    canonicalUrl: url,
    title,
    publishedAt: fileDate,
    content: boundedText(safeString(source.file_description), SUMMARY_MAX),
    metadata: { cik, accessionNumber: accession, primaryDocument: document, form, displayName },
  };
}

/** Collapse an EDGAR HTML/XBRL document to bounded plain text. This is a
 * presentation trim, not a parser: it drops scripts, styles, and inline-XBRL
 * header blocks so the text is the filing's narrative, never a bulk document. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|ix:header|ix:hidden)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function framePeriod(input: SecFramesInput): string {
  const year = Math.trunc(input.year);
  if (!Number.isFinite(year) || year < 1994 || year > 2100) throw new Error("sec_frames year must be between 1994 and 2100");
  if (input.quarter !== undefined) {
    const quarter = Math.trunc(input.quarter);
    if (quarter < 1 || quarter > 4) throw new Error("sec_frames quarter must be between 1 and 4");
    return `CY${year}Q${quarter}${input.instant ? "I" : ""}`;
  }
  if (input.instant) throw new Error("sec_frames instantaneous frames require a quarter");
  return `CY${year}`;
}

function filterValues(values: unknown[], period: string | undefined): unknown[] {
  if (!period) return values;
  return values.filter((value) => safeString((value as { end?: unknown })?.end) === period);
}

function frameResult(
  taxonomy: string,
  tag: string,
  unit: string,
  period: string,
  entry: SecFrameEntry,
): ConnectorResult | undefined {
  const cik = typeof entry.cik === "number" ? entry.cik : undefined;
  if (cik === undefined) return undefined;
  const entityName = safeString(entry.entityName);
  const value = typeof entry.val === "number" ? entry.val : undefined;
  if (value === undefined) return undefined;
  const end = safeString(entry.end);
  return {
    source: "sec-edgar",
    sourceId: `${padCik(cik)}:${taxonomy}:${tag}:${unit}:${period}`,
    canonicalUrl: `${SEC_COMPANY_FACTS_URL}/CIK${padCik(cik)}.json`,
    title: entityName ? `${entityName} — ${tag}` : `${tag} (${period})`,
    publishedAt: end,
    content: boundedText(`${entityName ?? `CIK ${padCik(cik)}`} ${tag} ${value} ${unit}`.trim(), SUMMARY_MAX),
    metadata: { cik, taxonomy, tag, unit, value, frame: period, end, accessionNumber: safeString(entry.accn) },
  };
}

function factResult(
  cik: number,
  taxonomy: string,
  tag: string,
  unit: string | undefined,
  values: unknown[],
): ConnectorResult {
  const bounded = values.slice(-12).map((value) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    return {
      end: safeString(entry.end),
      val: typeof entry.val === "number" ? entry.val : undefined,
      fy: typeof entry.fy === "number" ? entry.fy : undefined,
      fp: safeString(entry.fp),
      form: safeString(entry.form),
    };
  });
  return {
    source: "sec-edgar",
    sourceId: `${padCik(cik)}:${taxonomy}:${tag}`,
    canonicalUrl: `${SEC_COMPANY_FACTS_URL}/CIK${padCik(cik)}.json`,
    title: `${taxonomy} ${tag}`,
    content: boundedText(`${taxonomy} ${tag}${unit ? ` (${unit})` : ""}`, SUMMARY_MAX),
    metadata: { cik, taxonomy, tag, unit, values: bounded },
  };
}
