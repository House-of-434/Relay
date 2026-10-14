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
import { fetchJson } from "./http.js";
import { RateLimiter, TtlCache } from "./throttle.js";

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions";
export const SEC_COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
export const SEC_RATE_PER_SECOND = 10;

const TICKERS_TTL_MS = 12 * 60 * 60 * 1000;
const SUBMISSIONS_TTL_MS = 10 * 60 * 1000;
const FACTS_TTL_MS = 10 * 60 * 1000;
const SUMMARY_MAX = 500;

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

interface SecSubmissionsRecent {
  accessionNumber?: unknown;
  filingDate?: unknown;
  form?: unknown;
  primaryDocument?: unknown;
  reportDate?: unknown;
  primaryDocDescription?: unknown;
}

interface SecSubmissions {
  name?: unknown;
  filings?: { recent?: SecSubmissionsRecent; files?: unknown };
}

export interface SecSearchFilingsInput {
  company: string;
  formType?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SecCompanyFactsInput {
  company: string;
  tag?: string;
  taxonomy?: string;
  unit?: string;
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

function assertCalendarDate(value: string, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`sec_search_filings ${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`sec_search_filings ${field} must use YYYY-MM-DD`);
  }
}

export class SecProvider {
  private readonly userAgent: string;
  private readonly timeoutMs: number | undefined;
  private readonly fetcher: typeof fetch | undefined;
  private readonly limiter = new RateLimiter(SEC_RATE_PER_SECOND);
  private readonly tickers = new TtlCache<TickerRow[]>(TICKERS_TTL_MS, 4);
  private readonly submissions = new TtlCache<SecSubmissions>(SUBMISSIONS_TTL_MS);
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

  private async getJson<T>(url: string): Promise<T> {
    await this.limiter.acquire();
    return fetchJson<T>(url, { timeoutMs: this.timeoutMs, fetcher: this.fetcher, headers: this.headers() });
  }

  private async tickerRows(): Promise<TickerRow[]> {
    return this.tickers.getOrSet("all", async () => {
      const raw = await this.getJson<Record<string, TickerRow>>(SEC_TICKERS_URL);
      return Object.values(raw).filter((row) => row && typeof row.cik_str === "number");
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
    const recent = submissions.filings?.recent;
    if (!recent) return [];
    const count = Array.isArray(recent.accessionNumber) ? recent.accessionNumber.length : 0;
    const formFilter = input.formType?.trim().toUpperCase();
    const from = input.from?.trim();
    const to = input.to?.trim();
    if (from) assertCalendarDate(from, "from");
    if (to) assertCalendarDate(to, "to");
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const results: ConnectorResult[] = [];
    for (let index = 0; index < count && results.length < limit; index += 1) {
      const form = safeString((recent.form as unknown[])?.[index]);
      const filingDate = safeString((recent.filingDate as unknown[])?.[index]);
      const accession = safeString((recent.accessionNumber as unknown[])?.[index]);
      if (!form || !filingDate || !accession) continue;
      if (formFilter && form.toUpperCase() !== formFilter) continue;
      if (from && filingDate < from) continue;
      if (to && filingDate > to) continue;
      const primaryDocument = safeString((recent.primaryDocument as unknown[])?.[index]);
      const description = safeString((recent.primaryDocDescription as unknown[])?.[index]);
      results.push(filingResult(cik, { form, filingDate, accession, primaryDocument, description }));
    }
    return results;
  }

  async companyFacts(input: SecCompanyFactsInput): Promise<ConnectorResult[]> {
    const cik = await this.resolveCik(input.company);
    const raw = await this.facts.getOrSet(padCik(cik), () =>
      this.getJson<unknown>(`${SEC_COMPANY_FACTS_URL}/CIK${padCik(cik)}.json`));
    const facts = (raw as { facts?: Record<string, Record<string, unknown>> } | null)?.facts;
    if (!facts) return [];
    const taxonomy = input.taxonomy?.trim();
    const tagNeedle = input.tag?.trim().toLowerCase();
    const unitNeedle = input.unit?.trim().toLowerCase();
    const results: ConnectorResult[] = [];
    for (const [taxonomyName, tags] of Object.entries(facts)) {
      if (taxonomy && taxonomyName.toLowerCase() !== taxonomy.toLowerCase()) continue;
      for (const [tagName, definition] of Object.entries(tags ?? {})) {
        if (tagNeedle && !tagName.toLowerCase().includes(tagNeedle)) continue;
        const units = (definition as { units?: Record<string, unknown[]> }).units ?? {};
        const unitNames = Object.keys(units);
        let selectedUnit: string | undefined;
        if (unitNeedle) {
          selectedUnit = unitNames.find((name) => name.toLowerCase() === unitNeedle);
          if (!selectedUnit) continue;
        } else {
          selectedUnit = unitNames[0];
        }
        const values = selectedUnit ? (units[selectedUnit] ?? []) : [];
        results.push(factResult(cik, taxonomyName, tagName, selectedUnit, values));
        if (results.length >= 50) return results;
      }
    }
    return results;
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
    sourceId: `${taxonomy}:${tag}`,
    canonicalUrl: `${SEC_COMPANY_FACTS_URL}/CIK${padCik(cik)}.json`,
    title: `${taxonomy} ${tag}`,
    content: boundedText(`${taxonomy} ${tag}${unit ? ` (${unit})` : ""}`, SUMMARY_MAX),
    metadata: { cik, taxonomy, tag, unit, values: bounded },
  };
}
