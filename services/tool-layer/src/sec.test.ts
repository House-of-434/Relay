import assert from "node:assert/strict";
import test from "node:test";

import { SecProvider, SEC_COMPANY_FACTS_URL, SEC_SUBMISSIONS_URL, SEC_TICKERS_URL } from "./infra/sec.js";

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
  assert.equal(first.sourceId, "0000320193:us-gaap:Revenues");
  assert.equal(second.sourceId, "0000789019:us-gaap:Revenues");
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(first.canonicalUrl, second.canonicalUrl.replace("0000789019", "0000320193"));
});

test("filing citations are unchanged by fact source ID qualification", async () => {
  const provider = providerWith(GOOD_TICKERS, GOOD_SUBMISSIONS, { facts: {} });
  const [filing] = await provider.searchFilings({ company: "TST" });
  assert.ok(filing);
  assert.equal(filing.sourceId, "0000000000-24-000001");
});
