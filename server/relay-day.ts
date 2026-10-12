// Team-day computation for Relay data questions ("how many signed up today?").
//
// A bare `created_at_gte: "<YYYY-MM-DD>"` reads as UTC midnight in Postgres,
// which is wrong for a US team for part of every day. The turn injects the
// team's local midnight as a full RFC3339 timestamp with the team offset, and
// the prompt names the zone. The offset is computed with Intl at runtime —
// never hardcoded — so DST transitions are handled. The literal timestamp
// rides the per-turn message (volatile), never the stable prompt section.
export const DEFAULT_TEAM_TIMEZONE = "America/Los_Angeles";

export function teamTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.RELAY_TEAM_TIMEZONE?.trim();
  if (!raw) return DEFAULT_TEAM_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);
  } catch {
    throw new Error("RELAY_TEAM_TIMEZONE must be a valid IANA timezone such as America/Los_Angeles");
  }
  return raw;
}

function wallParts(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Local midnight of the team's current day as `YYYY-MM-DDT00:00:00±HH:MM`.
 * Iterates the offset lookup twice so a DST transition at/near midnight
 * converges instead of landing an hour off. */
export function teamMidnightIso(now: Date, timeZone: string): string {
  const { y, m, d } = wallParts(now, timeZone);
  const wallUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let utc = wallUtc - offsetMinutesAt(new Date(wallUtc), timeZone) * 60000;
  utc = wallUtc - offsetMinutesAt(new Date(utc), timeZone) * 60000;
  const offset = offsetMinutesAt(new Date(utc), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}T00:00:00${formatOffset(offset)}`;
}
