/** Freshness buckets over observed_at: research must be able to say how old
 * its evidence is. Thresholds are eval policy, not store policy. */

export type Freshness = "fresh" | "aging" | "stale";

const FRESH_MS = 7 * 24 * 60 * 60_000;
const AGING_MS = 30 * 24 * 60 * 60_000;

export function freshnessBucket(observedAt: string, nowMs: number): Freshness {
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) throw new Error(`unparseable observed_at: ${observedAt}`);
  const age = nowMs - at;
  if (age < 0) throw new Error(`observed_at is in the future: ${observedAt}`);
  if (age < FRESH_MS) return "fresh";
  if (age < AGING_MS) return "aging";
  return "stale";
}
