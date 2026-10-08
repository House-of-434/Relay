/** Source-attribution gate: every research finding must carry a retrievable
 * source and a confidence. Mirrors the Tool Layer write contract
 * (source_url must be an http(s) URL, confidence a number in [0,1]) so the
 * eval measures what the store enforces. */

export interface Finding {
  claim: string;
  source_url?: unknown;
  confidence?: unknown;
}

export interface AttributionResult {
  ok: boolean;
  errors: string[];
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateAttribution(findings: Finding[]): AttributionResult {
  const errors: string[] = [];
  findings.forEach((finding, index) => {
    if (!isHttpUrl(finding.source_url)) {
      errors.push(`finding ${index} (${finding.claim}): missing or invalid source_url`);
    }
    if (
      typeof finding.confidence !== "number" ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1
    ) {
      errors.push(`finding ${index} (${finding.claim}): confidence must be a number in [0,1]`);
    }
  });
  return { ok: errors.length === 0, errors };
}
