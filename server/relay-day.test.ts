import { describe, expect, it } from "vitest";

import { teamMidnightIso, teamTimeZone, DEFAULT_TEAM_TIMEZONE } from "./relay-day.ts";

const TZ = "America/Los_Angeles";

describe("teamTimeZone", () => {
  it("defaults to America/Los_Angeles", () => {
    expect(teamTimeZone({})).toBe(DEFAULT_TEAM_TIMEZONE);
  });

  it("accepts a valid IANA override and rejects garbage", () => {
    expect(teamTimeZone({ RELAY_TEAM_TIMEZONE: "America/New_York" })).toBe("America/New_York");
    expect(() => teamTimeZone({ RELAY_TEAM_TIMEZONE: "Mars/Olympus" })).toThrow(/IANA timezone/);
  });
});

describe("teamMidnightIso", () => {
  it("emits winter midnight with -08:00", () => {
    expect(teamMidnightIso(new Date("2026-01-15T12:00:00Z"), TZ)).toBe("2026-01-15T00:00:00-08:00");
  });

  it("emits summer midnight with -07:00", () => {
    expect(teamMidnightIso(new Date("2026-07-01T12:00:00Z"), TZ)).toBe("2026-07-01T00:00:00-07:00");
  });

  // Fall back 2026-11-01 02:00 → 01:00: midnight is still PDT (-07:00),
  // and the instant round-trips to the same wall date.
  it("handles the fall-back DST day 2026-11-01", () => {
    const iso = teamMidnightIso(new Date("2026-11-01T12:00:00Z"), TZ);
    expect(iso).toBe("2026-11-01T00:00:00-07:00");
    const back = new Date(iso);
    expect(back.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  // Spring forward 2026-03-08 02:00 → 03:00: midnight is PST (-08:00).
  it("handles the spring-forward DST day 2026-03-08", () => {
    const iso = teamMidnightIso(new Date("2026-03-08T12:00:00Z"), TZ);
    expect(iso).toBe("2026-03-08T00:00:00-08:00");
    expect(new Date(iso).toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("an evening UTC instant still resolves to the team's wall date", () => {
    // 2026-10-11T06:30Z is 2026-10-10 23:30 in Los Angeles.
    expect(teamMidnightIso(new Date("2026-10-11T06:30:00Z"), TZ)).toBe("2026-10-10T00:00:00-07:00");
  });
});
