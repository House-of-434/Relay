/** The one result shape every research connector returns.
 *
 * Each connector's provider-native payload is narrowed to exactly these
 * fields at the Tool Layer boundary, so Scout sees one consistent contract:
 * where the item came from, how to cite it, when it was published, and the
 * bounded content. Provider-native fields that do not survive the boundary
 * stay on the provider side. */
export type ConnectorSource = "arxiv" | "sec-edgar" | "github";

export interface ConnectorResult {
  /** Which connector produced this item. */
  source: ConnectorSource;
  /** Stable identifier within the source (arXiv id, SEC accession, repo full name). */
  sourceId: string;
  /** Canonical, human-openable URL used for citation and provenance. */
  canonicalUrl: string;
  title?: string;
  publishedAt?: string;
  updatedAt?: string;
  authors?: string[];
  /** Bounded abstract, summary, or file body. Never a bulk document. */
  content?: string;
  metadata?: Record<string, unknown>;
}

/** Collapse whitespace and cap a provider string so a single field can never
 * dominate the model's context. */
export function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
