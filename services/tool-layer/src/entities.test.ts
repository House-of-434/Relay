import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalDomain,
  companyReferenceDomain,
  mergeCompany,
  mergePerson,
  normalizeDomains,
  normalizeLinkedIn,
  normalizeName,
  resolveCompany,
  resolveCompanyReference,
  resolvePerson,
  type EntityCandidate,
} from "./domain/entities.js";

const candidate = (overrides: Partial<EntityCandidate>): EntityCandidate => ({ id: "c1", ...overrides });

test("canonicalDomain reduces a URL to its host", () => {
  assert.equal(canonicalDomain("https://www.Example.com/path?x=1"), "example.com");
  assert.equal(canonicalDomain("http://acme.io"), "acme.io");
  assert.equal(canonicalDomain("acme.io:443"), "acme.io");
  assert.equal(canonicalDomain("https://meet.google.com/abc-defg-hij"), "meet.google.com");
  assert.equal(canonicalDomain(""), null);
  assert.equal(canonicalDomain(null), null);
});

test("domains and names normalize without losing distinct values", () => {
  assert.deepEqual(normalizeDomains(["https://www.Acme.com", "acme.com", "acme.io"]), ["acme.com", "acme.io"]);
  assert.equal(normalizeName("  Acme, Inc. "), "acme inc");
  assert.equal(normalizeName("ACME INC"), "acme inc");
  assert.notEqual(normalizeName("Acme Inc"), normalizeName("Acme Labs"));
  assert.equal(normalizeLinkedIn("https://www.linkedin.com/in/Ada-Test/?trk=x"), "linkedin.com/in/ada-test");
  assert.equal(normalizeLinkedIn("https://uk.linkedin.com/in/ada-test/"), "linkedin.com/in/ada-test");
  assert.equal(normalizeLinkedIn("linkedin.com/in/ada-test/details/experience"), "linkedin.com/in/ada-test");
  assert.equal(normalizeLinkedIn("https://www.linkedin.com/company/acme"), null);
  assert.equal(normalizeLinkedIn("https://www.linkedin.com/school/acme"), null);
  assert.equal(normalizeLinkedIn("https://linkedin.com.evil.example/in/ada"), null);
  assert.equal(normalizeLinkedIn("https://example.com/in/ada"), null);
  assert.equal(normalizeLinkedIn(""), null);
});

test("a reported employer is a domain only when it names a host", () => {
  assert.equal(companyReferenceDomain("acme.com"), "acme.com");
  assert.equal(companyReferenceDomain("https://www.acme.com/about"), "acme.com");
  assert.equal(companyReferenceDomain("Acme Inc."), null);
  assert.equal(companyReferenceDomain("Acme"), null);
  assert.equal(companyReferenceDomain("ada@acme.com"), null);
});

test("a company resolves by any domain, not only the generated primary key", () => {
  const existing = candidate({ name: "Acme", domains: ["acme.com", "acme.io"], domain_key: "acme.com" });
  assert.deepEqual(resolveCompany([existing], { name: "Acme", domains: ["https://www.acme.io"] }), {
    action: "merge",
    candidate: existing,
    matchedBy: "domain",
  });
});

test("a company resolves by normalized name when identity fields agree", () => {
  const existing = candidate({ name: "Acme, Inc.", domains: ["acme.com"] });
  assert.equal(resolveCompany([existing], { name: "ACME INC", domains: ["https://acme.com"] }).action, "merge");
});

test("same name with a different canonical domain is queued for review", () => {
  const existing = candidate({ name: "Acme", domains: ["acme.com"] });
  const decision = resolveCompany([existing], { name: "Acme", domains: ["acme-labs.io"] });
  assert.equal(decision.action, "review");
});

test("several domain matches are queued, never guessed", () => {
  const first = candidate({ id: "c1", name: "Acme One", domains: ["acme.com"] });
  const second = candidate({ id: "c2", name: "Acme Two", domains: ["acme.com"] });
  assert.equal(resolveCompany([first, second], { name: "Acme", domains: ["acme.com"] }).action, "review");
});

test("a known company is inserted only when nothing matches", () => {
  assert.deepEqual(resolveCompany([], { name: "New Co", domains: ["new.example"] }), { action: "insert" });
});

test("a person's employer resolves by domain first, then normalized name", () => {
  const byDomain = candidate({ id: "c1", name: "Acme, Inc.", domains: ["acme.com"] });
  assert.deepEqual(resolveCompanyReference([byDomain], "https://www.acme.com/about"), {
    action: "match",
    candidate: byDomain,
    matchedBy: "domain",
  });

  const byName = candidate({ id: "c2", name: "Acme, Inc.", domains: ["acme.com"] });
  assert.deepEqual(resolveCompanyReference([byName], "ACME INC"), {
    action: "match",
    candidate: byName,
    matchedBy: "name",
  });
});

test("an ambiguous or missing employer never guesses", () => {
  const first = candidate({ id: "c1", name: "Acme", domains: ["acme.com"] });
  const second = candidate({ id: "c2", name: "Acme", domains: ["acme-labs.io"] });
  const ambiguous = resolveCompanyReference([first, second], "Acme");
  assert.equal(ambiguous.action, "review");

  assert.deepEqual(resolveCompanyReference([first], "Unknown Co"), { action: "none" });
  assert.deepEqual(resolveCompanyReference([], "acme.com"), { action: "none" });
});

test("a non-internal employer is queued instead of linked", () => {
  const privateCompany = candidate({ name: "Acme", domains: ["acme.com"], classification: "confidential" });
  assert.equal(resolveCompanyReference([privateCompany], "acme.com").action, "review");
});

test("a person resolves by LinkedIn first", () => {
  const existing = candidate({ full_name: "Ada Test", linkedin_url: "https://www.linkedin.com/in/ada-test/" });
  const decision = resolvePerson([existing], {
    full_name: "Ada Test",
    linkedin_url: "https://linkedin.com/in/ada-test",
    company_id: "other-company",
  });
  assert.equal(decision.action, "merge");
  assert.equal(decision.action === "merge" ? decision.matchedBy : null, "linkedin");
});

test("a person resolves by name and company, but not by a bare name", () => {
  const existing = candidate({ full_name: "Ada Test", company_id: "company-1" });
  assert.equal(resolvePerson([existing], { full_name: "Ada Test", company_id: "company-1" }).action, "merge");
  assert.equal(resolvePerson([existing], { full_name: "Ada Test", company_id: "company-2" }).action, "review");
  assert.equal(resolvePerson([existing], { full_name: "Ada Test" }).action, "review");
  assert.equal(resolvePerson([], { full_name: "New Person", company_id: "company-2" }).action, "insert");
});

test("mergeCompany fills, unions, promotes, and reports identity conflicts", () => {
  const existing = candidate({
    name: "Acme",
    domains: ["acme.com"],
    description: "Old",
    employee_count: 10,
    scope: "private",
    confidence: 0.8,
    source_url: "https://acme.com",
    source: "research",
  });
  const { values, conflicts } = mergeCompany(existing, {
    domains: ["https://acme.com", "https://www.acme.io"],
    description: "Newer",
    employee_count: 12,
    confidence: 0.9,
    source_url: "https://www.linkedin.com/company/acme",
    observed_at: "2026-01-01T00:00:00.000Z",
  }, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(conflicts, []);
  assert.deepEqual(values.domains, ["acme.com", "acme.io"]);
  assert.equal(values.description, "Newer");
  assert.equal(values.employee_count, 12);
  assert.equal(values.scope, "org");
  assert.equal(values.observed_at, "2026-02-01T00:00:00.000Z");
  assert.equal(values.confidence, 0.9);

  const conflict = mergeCompany(existing, { domains: ["different.example"], name: "Acme" }, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(conflict.conflicts, ["different canonical domain"]);
});

test("mergePerson unions arrays and links, keeps the earlier actor, and refreshes observed_at", () => {
  const existing = candidate({
    full_name: "Ada Test",
    aliases: ["Ada"],
    company_id: "company-1",
    title: "Engineer",
    education: ["IIT"],
    links: { x: "https://x.com/ada" },
    scope: "private",
    confidence: 0.6,
    source_url: "https://linkedin.com/in/ada-test",
    source: "research",
  });
  const { values, conflicts } = mergePerson(existing, {
    full_name: "Ada Test",
    aliases: ["Aditi"],
    company_id: "company-2",
    title: "Founder",
    education: ["Stanford"],
    links: { github: "https://github.com/ada" },
    confidence: 0.9,
    source_url: "https://example.com/ada",
    observed_at: "2026-01-01T00:00:00.000Z",
  }, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(conflicts, []);
  assert.deepEqual(values.aliases, ["Ada", "Aditi"]);
  assert.equal(values.company_id, "company-2");
  assert.equal(values.title, "Founder");
  assert.deepEqual(values.education, ["IIT", "Stanford"]);
  assert.deepEqual(values.links, { x: "https://x.com/ada", github: "https://github.com/ada" });
  assert.equal(values.scope, "org");
  assert.equal(values.observed_at, "2026-02-01T00:00:00.000Z");
});
