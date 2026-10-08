/** web_search provider contract (Phase 4 target) plus a fixture stub.
 * The eval pins the CONTRACT — exact-URL discovery and URL canonical form —
 * so providers (TinyFish now, self-hosted later) stay interchangeable. */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

export function stubProvider(entries: Record<string, SearchResult[]>): SearchProvider {
  return {
    async search(query: string): Promise<SearchResult[]> {
      return entries[query] ?? [];
    },
  };
}

/** Canonical URL form for discovery comparison: lowercase host, no
 * fragment, no tracking params, no bare-domain trailing slash. */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  const tracking: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("utm_")) tracking.push(key);
  }
  for (const key of tracking) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  const out = url.toString();
  if (out.endsWith("/") && url.pathname === "/" && !url.search) return out.slice(0, -1);
  return out;
}
