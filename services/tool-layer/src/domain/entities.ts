/** Pure identity resolution for the shared company/person directory.
 *
 * The Tool Layer is the only writer, so this is where a re-research either
 * merges into the canonical row, inserts a new one, or queues an ambiguous
 * match for a person to review. No database access and no model calls here.
 */

export interface EntityCandidate {
  id: string;
  name?: unknown;
  full_name?: unknown;
  domains?: unknown;
  domain_key?: unknown;
  linkedin_url?: unknown;
  company_id?: unknown;
  description?: unknown;
  location?: unknown;
  employee_count?: unknown;
  industry?: unknown;
  vertical?: unknown;
  technology?: unknown;
  stage?: unknown;
  company_type?: unknown;
  domain_expertise?: unknown;
  website?: unknown;
  tags?: unknown;
  aliases?: unknown;
  person_type?: unknown;
  title?: unknown;
  bio?: unknown;
  education?: unknown;
  links?: unknown;
  source?: unknown;
  source_url?: unknown;
  confidence?: unknown;
  observed_at?: unknown;
  classification?: unknown;
  scope?: unknown;
}

export type EntityMatch = "domain" | "name" | "linkedin" | "company";

export type EntityResolution =
  | { action: "insert" }
  | { action: "merge"; candidate: EntityCandidate; matchedBy: EntityMatch }
  | { action: "review"; candidates: EntityCandidate[]; reason: string };

export interface MergeResult {
  values: Record<string, unknown>;
  conflicts: string[];
}

/** Host-only key, mirroring app.domain_key(): lower, no scheme, no path,
 *  no port, no query/fragment, no www. */
export function canonicalDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.split("/")[0] ?? "";
  text = text.split("?")[0] ?? "";
  text = text.split("#")[0] ?? "";
  text = text.split(":")[0] ?? "";
  text = text.replace(/^www\./, "");
  return text || null;
}

export function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const domain = canonicalDomain(entry);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** Case/whitespace/punctuation-insensitive identity. "Acme, Inc." and
 *  "ACME INC" are the same name; the canonical spelling stays on the row. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** LinkedIn profile key: lower, no scheme/www, no query/fragment, no trailing
 *  slash. Anything that is not a LinkedIn URL is ignored. */
export function normalizeLinkedIn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, "").replace(/^www\./, "");
  text = text.split("?")[0] ?? "";
  text = text.split("#")[0] ?? "";
  text = text.replace(/\/+$/, "");
  return text.startsWith("linkedin.com/") ? text : null;
}

function confidenceOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function union(existing: unknown, incoming: unknown): string[] {
  const out: string[] = [];
  for (const value of [existing, incoming]) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim() && !out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

function mergedObject(existing: unknown, incoming: unknown): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const next = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? incoming as Record<string, unknown>
    : {};
  return { ...base, ...next };
}

/** Mutable facts are taken from the newer observation only when its
 *  confidence is at least the row's. Identity fields are resolved before this
 *  runs and never overwritten here. */
function prefer(incoming: unknown, existing: unknown, incomingConfidence: number, existingConfidence: number): unknown {
  if (!hasValue(incoming)) return existing;
  if (!hasValue(existing)) return incoming;
  return incomingConfidence >= existingConfidence ? incoming : existing;
}

function chooseSourceUrl(
  existing: unknown,
  incoming: unknown,
  canonicalUrls: readonly string[],
): unknown {
  if (!hasValue(existing)) return incoming;
  if (!hasValue(incoming)) return existing;
  const existingText = typeof existing === "string" ? existing.toLowerCase() : "";
  const incomingText = typeof incoming === "string" ? incoming.toLowerCase() : "";
  const canonical = canonicalUrls.filter((url) => typeof url === "string" && url.length > 0).map((url) => url.toLowerCase());
  if (canonical.some((url) => existingText.includes(url))) return existing;
  if (canonical.some((url) => incomingText.includes(url))) return incoming;
  return existing;
}

function isDirectoryRow(candidate: EntityCandidate): boolean {
  return (candidate.classification ?? "internal") === "internal";
}

function uniqueById(candidates: EntityCandidate[]): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function reviewFor(candidates: EntityCandidate[], reason: string): EntityResolution {
  return { action: "review", candidates: uniqueById(candidates), reason };
}

/** Decide what an incoming company write is: merge an unambiguous canonical
 *  row, insert a new one, or queue a human decision. Domain overlap wins; a
 *  name match needs both sides to agree on identity (no conflicting domain or
 *  LinkedIn). */
export function resolveCompany(candidates: EntityCandidate[], incoming: Record<string, unknown>): EntityResolution {
  const domains = normalizeDomains(incoming.domains);
  const primary = domains[0] ?? null;
  const name = normalizeName(incoming.name);
  const linkedin = normalizeLinkedIn(incoming.linkedin_url);

  const domainMatches = candidates.filter((candidate) => {
    const existingDomains = normalizeDomains(candidate.domains);
    return domains.some((domain) => existingDomains.includes(domain));
  });
  const keyMatches = primary
    ? candidates.filter((candidate) => typeof candidate.domain_key === "string" && candidate.domain_key === primary)
    : [];

  const domainHits = uniqueById([...domainMatches, ...keyMatches]);
  if (domainHits.length > 1) {
    return reviewFor(domainHits, "several companies share a domain");
  }
  if (domainHits.length === 1) {
    const candidate = domainHits[0]!;
    if (!isDirectoryRow(candidate)) return reviewFor([candidate], "existing row is not an internal directory record");
    return { action: "merge", candidate, matchedBy: "domain" };
  }

  const nameHits = name
    ? candidates.filter((candidate) => normalizeName(candidate.name) === name)
    : [];
  if (nameHits.length > 1) {
    return reviewFor(nameHits, "several companies share a name");
  }
  if (nameHits.length === 1) {
    const candidate = nameHits[0]!;
    if (!isDirectoryRow(candidate)) return reviewFor([candidate], "existing row is not an internal directory record");
    const existingDomains = normalizeDomains(candidate.domains);
    if (primary && existingDomains[0] && !existingDomains.includes(primary)) {
      return reviewFor([candidate], "same name, different canonical domain");
    }
    const existingLinkedIn = normalizeLinkedIn(candidate.linkedin_url);
    if (linkedin && existingLinkedIn && linkedin !== existingLinkedIn) {
      return reviewFor([candidate], "same name, different LinkedIn profile");
    }
    return { action: "merge", candidate, matchedBy: "name" };
  }

  return { action: "insert" };
}

/** Decide an incoming person write. LinkedIn is the strongest key, then the
 *  exact normalized name at the same company. A bare name is never enough. */
export function resolvePerson(candidates: EntityCandidate[], incoming: Record<string, unknown>): EntityResolution {
  const linkedin = normalizeLinkedIn(incoming.linkedin_url);
  const name = normalizeName(incoming.full_name);
  const companyId = typeof incoming.company_id === "string" ? incoming.company_id : null;

  const linkedinHits = linkedin
    ? candidates.filter((candidate) => normalizeLinkedIn(candidate.linkedin_url) === linkedin)
    : [];
  if (linkedinHits.length > 1) {
    return reviewFor(linkedinHits, "several people share a LinkedIn profile");
  }
  if (linkedinHits.length === 1) {
    const candidate = linkedinHits[0]!;
    if (!isDirectoryRow(candidate)) return reviewFor([candidate], "existing row is not an internal directory record");
    return { action: "merge", candidate, matchedBy: "linkedin" };
  }

  const sameCompany = (candidate: EntityCandidate) => companyId !== null && candidate.company_id === companyId;
  const nameHits = name
    ? candidates.filter((candidate) => normalizeName(candidate.full_name) === name)
    : [];
  const companyHits = nameHits.filter(sameCompany);
  if (companyHits.length > 1) {
    return reviewFor(companyHits, "several people share a name at this company");
  }
  if (companyHits.length === 1) {
    const candidate = companyHits[0]!;
    if (!isDirectoryRow(candidate)) return reviewFor([candidate], "existing row is not an internal directory record");
    const existingLinkedIn = normalizeLinkedIn(candidate.linkedin_url);
    if (linkedin && existingLinkedIn && linkedin !== existingLinkedIn) {
      return reviewFor([candidate], "same name and company, different LinkedIn profile");
    }
    return { action: "merge", candidate, matchedBy: "company" };
  }

  if (nameHits.length > 0) {
    return reviewFor(nameHits, "same name but no company or LinkedIn to confirm identity");
  }

  return { action: "insert" };
}

/** Merge incoming company fields into an existing row. Identity was already
 *  checked by resolveCompany; a conflict here means the write must be queued. */
export function mergeCompany(
  existing: EntityCandidate,
  incoming: Record<string, unknown>,
  now: string,
): MergeResult {
  const conflicts: string[] = [];
  const existingDomains = normalizeDomains(existing.domains);
  const incomingDomains = normalizeDomains(incoming.domains);
  const existingPrimary = existingDomains[0] ?? null;
  const incomingPrimary = incomingDomains[0] ?? null;
  if (existingPrimary && incomingPrimary && !existingDomains.includes(incomingPrimary)) {
    conflicts.push("different canonical domain");
  }
  const existingLinkedIn = normalizeLinkedIn(existing.linkedin_url);
  const incomingLinkedIn = normalizeLinkedIn(incoming.linkedin_url);
  if (existingLinkedIn && incomingLinkedIn && existingLinkedIn !== incomingLinkedIn) {
    conflicts.push("different LinkedIn profile");
  }

  const existingConfidence = confidenceOf(existing.confidence);
  const incomingConfidence = confidenceOf(incoming.confidence);
  const domains = [...existingDomains];
  for (const domain of incomingDomains) if (!domains.includes(domain)) domains.push(domain);

  const values: Record<string, unknown> = {
    domains,
    description: prefer(incoming.description, existing.description, incomingConfidence, existingConfidence),
    location: prefer(incoming.location, existing.location, incomingConfidence, existingConfidence),
    employee_count: prefer(incoming.employee_count, existing.employee_count, incomingConfidence, existingConfidence),
    industry: prefer(incoming.industry, existing.industry, incomingConfidence, existingConfidence),
    vertical: prefer(incoming.vertical, existing.vertical, incomingConfidence, existingConfidence),
    technology: prefer(incoming.technology, existing.technology, incomingConfidence, existingConfidence),
    stage: prefer(incoming.stage, existing.stage, incomingConfidence, existingConfidence),
    company_type: prefer(incoming.company_type, existing.company_type, incomingConfidence, existingConfidence),
    domain_expertise: prefer(incoming.domain_expertise, existing.domain_expertise, incomingConfidence, existingConfidence),
    website: prefer(incoming.website, existing.website, incomingConfidence, existingConfidence),
    linkedin_url: hasValue(existing.linkedin_url) ? existing.linkedin_url : incoming.linkedin_url,
    tags: union(existing.tags, incoming.tags),
    source_url: chooseSourceUrl(existing.source_url, incoming.source_url, [existingPrimary ?? "", incomingPrimary ?? "", incomingLinkedIn ?? ""]),
    observed_at: now,
    confidence: Math.max(existingConfidence, incomingConfidence),
    scope: existing.scope === "private" ? "org" : existing.scope,
    source: hasValue(existing.source) ? existing.source : incoming.source,
  };
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete values[key];
  }
  return { values, conflicts };
}

/** Merge incoming person fields into an existing row. Same contract as
 *  mergeCompany. */
export function mergePerson(
  existing: EntityCandidate,
  incoming: Record<string, unknown>,
  now: string,
): MergeResult {
  const conflicts: string[] = [];
  const existingLinkedIn = normalizeLinkedIn(existing.linkedin_url);
  const incomingLinkedIn = normalizeLinkedIn(incoming.linkedin_url);
  if (existingLinkedIn && incomingLinkedIn && existingLinkedIn !== incomingLinkedIn) {
    conflicts.push("different LinkedIn profile");
  }

  const existingConfidence = confidenceOf(existing.confidence);
  const incomingConfidence = confidenceOf(incoming.confidence);
  const values: Record<string, unknown> = {
    aliases: union(existing.aliases, incoming.aliases),
    person_type: union(existing.person_type, incoming.person_type),
    company_id: prefer(incoming.company_id, existing.company_id, incomingConfidence, existingConfidence),
    title: prefer(incoming.title, existing.title, incomingConfidence, existingConfidence),
    location: prefer(incoming.location, existing.location, incomingConfidence, existingConfidence),
    bio: prefer(incoming.bio, existing.bio, incomingConfidence, existingConfidence),
    linkedin_url: hasValue(existing.linkedin_url) ? existing.linkedin_url : incoming.linkedin_url,
    education: union(existing.education, incoming.education),
    links: mergedObject(existing.links, incoming.links),
    tags: union(existing.tags, incoming.tags),
    source_url: chooseSourceUrl(existing.source_url, incoming.source_url, [existingLinkedIn ?? "", incomingLinkedIn ?? ""]),
    observed_at: now,
    confidence: Math.max(existingConfidence, incomingConfidence),
    scope: existing.scope === "private" ? "org" : existing.scope,
    source: hasValue(existing.source) ? existing.source : incoming.source,
  };
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete values[key];
  }
  return { values, conflicts };
}
