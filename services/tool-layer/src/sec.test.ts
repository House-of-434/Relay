import assert from "node:assert/strict";
import test from "node:test";

import { SecProvider, SEC_ARCHIVES_BASE, SEC_COMPANY_FACTS_URL, SEC_FULL_TEXT_URL, SEC_SUBMISSIONS_URL, SEC_TICKERS_URL } from "./infra/sec.js";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(options: { tickers: unknown; submissions: unknown; facts: unknown }): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    if (key === SEC_TICKERS_URL) return json(options.tickers);
    if (key.startsWith(SEC_SUBMISSIONS_URL)) return json(options.submissions);
    if (key.startsWith(SEC_COMPANY_FACTS_URL)) return json(options.facts);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const GOOD_TICKERS = {
  "0": { cik_str: 123, ticker: "TST", title: "Test Inc" },
};

const GOOD_SUBMISSIONS = {
  filings: {
    recent: {
      accessionNumber: ["0000000000-24-000001"],
      filingDate: ["2024-05-01"],
      form: ["10-K"],
      primaryDocument: ["tst-10k.htm"],
      reportDate: ["2024-03-31"],
      primaryDocDescription: ["Annual report"],
    },
  },
};

function providerWith(tickers: unknown, submissions: unknown, facts: unknown): SecProvider {
  return new SecProvider({ userAgent: "Relay Test (test@example.com)", fetcher: stubFetch({ tickers, submissions, facts }) });
}

test("non-calendar from/to are rejected instead of silently matching nothing", async () => {
  const provider = providerWith(GOOD_TICKERS, GOOD_SUBMISSIONS, { facts: {} });
  await assert.rejects(provider.searchFilings({ company: "TST", from: "2024-13-99" }), /YYYY-MM-DD/);
  await assert.rejects(provider.searchFilings({ company: "TST", to: "2024-02-30" }), /YYYY-MM-DD/);
  const ok = await provider.searchFilings({ company: "TST", from: "2024-01-01", to: "2024-12-31" });
  assert.equal(ok.length, 1);
});

test("unit matching is case-insensitive", async () => {
  const facts = { facts: { "us-gaap": { Revenue: { units: { USD: [{ end: "2024-12-31", val: 100 }] } } } } };
  const provider = providerWith(GOOD_TICKERS, GOOD_SUBMISSIONS, facts);
  const results = await provider.companyFacts({ company: "TST", unit: "usd" });
  assert.equal(results.length, 1);
  assert.equal((results[0]!.metadata as { unit?: string }).unit, "USD");
});

test("malformed ticker rows are skipped instead of breaking resolution", async () => {
  const tickers = {
    "0": { cik_str: 123, ticker: "TST", title: "Test Inc" },
    "1": { cik_str: 456 },
    "2": { cik_str: 789, ticker: 42, title: null },
  };
  const provider = providerWith(tickers, GOOD_SUBMISSIONS, { facts: {} });
  const resolved = await provider.resolveCompany("TST");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.cik, 123);
});

test("fact tags with no units are skipped instead of returning empty results", async () => {
  const facts = { facts: { "us-gaap": { EmptyTag: { units: {} } } } };
  const provider = providerWith(GOOD_TICKERS, GOOD_SUBMISSIONS, facts);
  assert.deepEqual(await provider.companyFacts({ company: "TST" }), []);
});

test("identical taxonomy/tag pairs from different companies produce distinct source IDs", async () => {
  const tickers = {
    "0": { cik_str: 320193, ticker: "AAA", title: "Alpha Inc" },
    "1": { cik_str: 789019, ticker: "BBB", title: "Beta Inc" },
  };
  const facts = { facts: { "us-gaap": { Revenues: { units: { USD: [{ end: "2024-12-31", val: 100 }] } } } } };
  const provider = providerWith(tickers, GOOD_SUBMISSIONS, facts);
  const [first] = await provider.companyFacts({ company: "AAA" });
  const [second] = await provider.companyFacts({ company: "BBB" });
  assert.ok(first && second);
  assert.equal(first.sourceId, "0000320193:us-gaap:Revenues:USD");
  assert.equal(second.sourceId, "0000789019:us-gaap:Revenues:USD");
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(first.canonicalUrl, second.canonicalUrl.replace("0000789019", "0000320193"));
});

test("filing citations are unchanged by fact source ID qualification", async () => {
  const provider = providerWith(GOOD_TICKERS, GOOD_SUBMISSIONS, { facts: {} });
  const [filing] = await provider.searchFilings({ company: "TST" });
  assert.ok(filing);
  assert.equal(filing.sourceId, "0000000000-24-000001");
});

test("a missing fair-access User-Agent fails closed rather than calling SEC", () => {
  // SEC requires a declared identity; without one the connector must refuse to
  // exist rather than send anonymous traffic.
  assert.throws(() => new SecProvider({ userAgent: "" }), /RELAY_SEC_USER_AGENT/);
  assert.throws(() => new SecProvider({ userAgent: "   " }), /RELAY_SEC_USER_AGENT/);
});

const UA = "Relay Test (test@example.com)";

/** Route a request by URL prefix, returning a fresh Response per call so a
 * retry or a repeated fetch cannot consume a shared body. */
function routed(routes: Array<[string, () => Response]>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    for (const [prefix, make] of routes) {
      if (key === prefix || key.startsWith(prefix)) return make();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("full-text search maps hits to canonical EDGAR URLs and skips malformed ones", async () => {
  const payload = {
    hits: {
      hits: [
        {
          _id: "0000035527-22-000119:fitbannualreport202110-k.pdf",
          _source: {
            ciks: ["0000035527"],
            display_names: ["FIFTH THIRD BANCORP  (FITB)  (CIK 0000035527)"],
            form: "10-K",
            file_date: "2022-02-25",
            adsh: "0000035527-22-000119",
            file_description: "10-K",
          },
        },
        { _id: "not-a-filing", _source: {} },
      ],
    },
  };
  const provider = new SecProvider({ userAgent: UA, fetcher: routed([[SEC_FULL_TEXT_URL, () => json(payload)]]) });
  const results = await provider.searchFullText({ query: '"climate risk"', forms: "10-K", limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.sourceId, "0000035527-22-000119:fitbannualreport202110-k.pdf");
  assert.equal(
    results[0]!.canonicalUrl,
    "https://www.sec.gov/Archives/edgar/data/35527/000003552722000119/fitbannualreport202110-k.pdf",
  );
  assert.equal(results[0]!.publishedAt, "2022-02-25");
  assert.match(results[0]!.title!, /FIFTH THIRD BANCORP/);
});

test("includeHistory reaches filings older than the recent window", async () => {
  const submissions = {
    filings: {
      recent: {
        accessionNumber: ["0000000000-24-000001"],
        filingDate: ["2024-05-01"],
        form: ["10-K"],
        primaryDocument: ["recent.htm"],
      },
      files: [{ name: "CIK0000000123-submissions-001.json", filingFrom: "1995-01-01", filingTo: "2005-01-01" }],
    },
  };
  const historyPage = {
    accessionNumber: ["0000000000-01-000005"],
    filingDate: ["2001-03-15"],
    form: ["10-K"],
    primaryDocument: ["old.htm"],
  };
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(GOOD_TICKERS)],
    [`${SEC_SUBMISSIONS_URL}/CIK0000000123.json`, () => json(submissions)],
    [`${SEC_SUBMISSIONS_URL}/CIK0000000123-submissions-001.json`, () => json(historyPage)],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  assert.deepEqual(await provider.searchFilings({ company: "TST", from: "2001-01-01", to: "2001-12-31" }), []);
  const withHistory = await provider.searchFilings({
    company: "TST",
    from: "2001-01-01",
    to: "2001-12-31",
    includeHistory: true,
  });
  assert.equal(withHistory.length, 1);
  assert.equal(withHistory[0]!.sourceId, "0000000000-01-000005");
  assert.equal(
    withHistory[0]!.canonicalUrl,
    "https://www.sec.gov/Archives/edgar/data/123/000000000001000005/old.htm",
  );
});

test("getFiling reads the primary document as bounded, script-free text", async () => {
  const html =
    "<html><head><style>.x{color:red}</style><script>ignore()</script></head>" +
    "<body><p>Revenue was &amp; strong</p><p>Risk factors follow.</p></body></html>";
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(GOOD_TICKERS)],
    [`${SEC_SUBMISSIONS_URL}/CIK0000000123.json`, () => json(GOOD_SUBMISSIONS)],
    [`${SEC_ARCHIVES_BASE}/123/`, () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  const filing = await provider.getFiling({ company: "TST", accessionNumber: "0000000000-24-000001" });
  assert.equal(filing.canonicalUrl, `${SEC_ARCHIVES_BASE}/123/000000000024000001/tst-10k.htm`);
  assert.equal(filing.content, "Revenue was & strong Risk factors follow.");
  assert.equal((filing.metadata as Record<string, unknown>).truncated, false);
});

test("getFiling refuses a document that is not readable text", async () => {
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(GOOD_TICKERS)],
    [`${SEC_SUBMISSIONS_URL}/CIK0000000123.json`, () => json(GOOD_SUBMISSIONS)],
    [`${SEC_ARCHIVES_BASE}/123/`, () => new Response("PK", { status: 200, headers: { "content-type": "application/zip" } })],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  await assert.rejects(
    provider.getFiling({ company: "TST", accessionNumber: "0000000000-24-000001" }),
    /not readable text/,
  );
});

test("getFiling rejects an accession number that is not well-formed", async () => {
  const provider = new SecProvider({ userAgent: UA, fetcher: routed([[SEC_TICKERS_URL, () => json(GOOD_TICKERS)]]) });
  await assert.rejects(
    provider.getFiling({ company: "TST", accessionNumber: "not-an-accession" }),
    /accession number/,
  );
});

test("frames builds the calendar-period token and maps filers", async () => {
  const seen: string[] = [];
  const payload = {
    data: [
      { cik: 320193, entityName: "Apple Inc.", end: "2019-03-30", val: 100, accn: "0000320193-19-000001" },
      { cik: 789019, entityName: "Microsoft", end: "2019-03-31", val: 200 },
      { entityName: "no cik" },
    ],
  };
  const fetcher = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return json(payload);
  }) as typeof fetch;
  const provider = new SecProvider({ userAgent: UA, fetcher });
  const results = await provider.frames({ tag: "Assets", unit: "USD", year: 2019, quarter: 1, instant: true });
  assert.ok(seen[0]!.endsWith("/us-gaap/Assets/USD/CY2019Q1I.json"), seen[0]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.publishedAt, "2019-03-30");
  assert.equal((results[0]!.metadata as Record<string, unknown>).value, 100);
});

test("frames period semantics reject impossible tokens", async () => {
  const seen: string[] = [];
  const provider = new SecProvider({
    userAgent: UA,
    fetcher: (async (url: string | URL | Request) => {
      seen.push(String(url));
      return json({ data: [] });
    }) as typeof fetch,
  });
  await provider.frames({ tag: "Assets", unit: "USD", year: 2023 });
  assert.ok(seen.at(-1)!.endsWith("/CY2023.json"));
  await provider.frames({ tag: "Assets", unit: "USD", year: 2023, quarter: 4, instant: true });
  assert.ok(seen.at(-1)!.endsWith("/CY2023Q4I.json"));
  await assert.rejects(provider.frames({ tag: "Assets", unit: "USD", year: 2023, instant: true }), /require a quarter/);
  await assert.rejects(provider.frames({ tag: "Assets", unit: "USD", year: 2023, quarter: 9 }), /quarter/);
});

test("compareFacts returns one result per company for the same tag", async () => {
  const tickers = {
    "0": { cik_str: 320193, ticker: "AAA", title: "Alpha Inc" },
    "1": { cik_str: 789019, ticker: "BBB", title: "Beta Inc" },
  };
  const factsFor = (val: number) => ({
    facts: { "us-gaap": { Revenues: { units: { USD: [{ end: "2024-12-31", val }] } } } },
  });
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(tickers)],
    [`${SEC_COMPANY_FACTS_URL}/CIK0000320193.json`, () => json(factsFor(100))],
    [`${SEC_COMPANY_FACTS_URL}/CIK0000789019.json`, () => json(factsFor(200))],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  const results = await provider.compareFacts({ companies: ["AAA", "BBB"], tag: "Revenues" });
  assert.equal(results.length, 2);
  assert.equal(results[0]!.sourceId, "0000320193:us-gaap:Revenues:USD");
  assert.equal((results[0]!.metadata as { values: Array<{ val: number }> }).values[0]!.val, 100);
  assert.equal((results[1]!.metadata as { values: Array<{ val: number }> }).values[0]!.val, 200);
  await assert.rejects(provider.compareFacts({ companies: ["AAA"], tag: "Revenues" }), /at least two/);
});

test("companyFacts period selects only values ending on that date", async () => {
  const facts = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: { USD: [{ end: "2023-12-31", val: 1 }, { end: "2024-12-31", val: 2 }] },
        },
      },
    },
  };
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(GOOD_TICKERS)],
    [`${SEC_COMPANY_FACTS_URL}/CIK0000000123.json`, () => json(facts)],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  const [result] = await provider.companyFacts({ company: "TST", tag: "Revenues", period: "2023-12-31" });
  assert.ok(result);
  assert.equal((result.metadata as { values: unknown[] }).values.length, 1);
  assert.equal((result.metadata as { values: Array<{ val: number }> }).values[0]!.val, 1);
  await assert.rejects(provider.companyFacts({ company: "TST", period: "2024-13-01" }), /YYYY-MM-DD/);
});

test("frames skips entries without a numeric val", async () => {
  const payload = {
    data: [
      { cik: 320193, entityName: "Apple Inc.", end: "2019-03-30" },
      { cik: 320193, entityName: "Apple Inc.", end: "2019-03-30", val: 100, accn: "0000320193-19-000001" },
    ],
  };
  const provider = new SecProvider({
    userAgent: UA,
    fetcher: (async () => json(payload)) as typeof fetch,
  });
  const results = await provider.frames({ tag: "Assets", unit: "USD", year: 2019, quarter: 1, instant: true });
  assert.equal(results.length, 1);
  assert.equal((results[0]!.metadata as Record<string, unknown>).value, 100);
});

test("companyFacts skips values without a numeric val", async () => {
  const facts = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: { USD: [{ end: "2024-12-31", form: "10-K" }] },
        },
      },
    },
  };
  const fetcher = routed([
    [SEC_TICKERS_URL, () => json(GOOD_TICKERS)],
    [`${SEC_COMPANY_FACTS_URL}/CIK0000000123.json`, () => json(facts)],
  ]);
  const provider = new SecProvider({ userAgent: UA, fetcher });
  assert.deepEqual(await provider.companyFacts({ company: "TST", tag: "Revenues" }), []);
});

