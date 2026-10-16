import assert from "node:assert/strict";
import test from "node:test";

import { ARXIV_MAX_OFFSET, ArxivProvider } from "./infra/arxiv.js";
import { SerialGate } from "./infra/throttle.js";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-01-23T18:00:00Z</updated>
    <published>2024-01-22T18:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>We propose a new simple network architecture, the Transformer.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment>14 pages, 3 figures</arxiv:comment>
    <arxiv:journal_ref>NeurIPS 2017</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/2401.12345v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v2" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

function providerCapturing(seen: string[]): ArxivProvider {
  const fetcher = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(SAMPLE_FEED, { status: 200, headers: { "content-type": "application/atom+xml" } });
  }) as typeof fetch;
  return new ArxivProvider({ userAgent: "Relay Test (test@example.com)", fetcher, gate: new SerialGate(0) });
}

test("abstract filter, ordering, and offset map onto the export query", async () => {
  const seen: string[] = [];
  const provider = providerCapturing(seen);
  const results = await provider.search({
    query: "transformers",
    abstract: "attention",
    offset: 20,
    order: "ascending",
    sort: "submitted",
    limit: 5,
  });
  const url = new URL(seen[0]!);
  assert.equal(url.searchParams.get("search_query"), 'all:"transformers" AND abs:"attention"');
  assert.equal(url.searchParams.get("start"), "20");
  assert.equal(url.searchParams.get("max_results"), "5");
  assert.equal(url.searchParams.get("sortBy"), "submittedDate");
  assert.equal(url.searchParams.get("sortOrder"), "ascending");
  assert.equal(results.length, 1);
});

test("absent options keep the previous defaults", async () => {
  const seen: string[] = [];
  const provider = providerCapturing(seen);
  await provider.search({ query: "circuits" });
  const url = new URL(seen[0]!);
  assert.equal(url.searchParams.get("search_query"), 'all:"circuits"');
  assert.equal(url.searchParams.get("start"), "0");
  assert.equal(url.searchParams.get("sortBy"), "relevance");
  assert.equal(url.searchParams.get("sortOrder"), "descending");
});

test("offset is clamped to the supported window", async () => {
  const seen: string[] = [];
  const provider = providerCapturing(seen);
  await provider.search({ query: "x", offset: 999_999 });
  assert.equal(new URL(seen[0]!).searchParams.get("start"), String(ARXIV_MAX_OFFSET));
  await provider.search({ query: "x", offset: -5 });
  assert.equal(new URL(seen[1]!).searchParams.get("start"), "0");
});

test("abstract-only search is allowed; an empty search is rejected", async () => {
  const seen: string[] = [];
  const provider = providerCapturing(seen);
  await provider.search({ query: "", abstract: "diffusion" });
  assert.equal(new URL(seen[0]!).searchParams.get("search_query"), 'abs:"diffusion"');
  await assert.rejects(provider.search({ query: "" }), /requires a query/);
});

test("extras from the feed surface as bounded metadata", async () => {
  const provider = providerCapturing([]);
  const [paper] = await provider.search({ query: "x" });
  assert.ok(paper);
  assert.equal(paper.sourceId, "2401.12345");
  assert.equal(paper.canonicalUrl, "https://arxiv.org/abs/2401.12345");
  assert.equal((paper.metadata as Record<string, unknown>).pdfUrl, "http://arxiv.org/pdf/2401.12345v2");
  assert.equal((paper.metadata as Record<string, unknown>).comment, "14 pages, 3 figures");
  assert.equal((paper.metadata as Record<string, unknown>).journalRef, "NeurIPS 2017");
});
