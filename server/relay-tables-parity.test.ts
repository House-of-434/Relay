import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHAPES } from "../services/tool-layer/src/domain/shapes.ts";
import {
  buildSystemPrompt,
  RELAY_TABLE_SUMMARY,
  relayDayPrompt,
  relayPromptParts,
  relayTablesPrompt,
} from "./system-prompt.ts";

describe("Relay tables prompt", () => {
  it("names the tables agents can actually read", () => {
    const text = relayTablesPrompt();
    for (const table of RELAY_TABLE_SUMMARY) expect(text).toContain(table.split(".")[1]!);
    expect(text).toContain("not live");
    expect(text).toContain("(yours only)");
    expect(text).toContain("head:true");
    expect(text).not.toContain("meetings");
  });

  it("matches the shapes registry: every listed table is shaped, every shaped table listed", () => {
    const shaped = Object.keys(SHAPES).sort();
    expect([...RELAY_TABLE_SUMMARY].sort()).toEqual(shaped);
  });

  it("day line carries a placeholder note, not a literal timestamp", () => {
    const text = relayDayPrompt("<midnight>", "America/Los_Angeles");
    expect(text).toContain("see timestamp in this turn");
    expect(text).toContain("created_at_gte");
    expect(text).toContain("America/Los_Angeles");
  });

  it("tables ride the stable half, the day line the volatile half", () => {
    const built = buildSystemPrompt("persona", "", relayPromptParts("2026-10-11T00:00:00-07:00", "America/Los_Angeles"));
    expect(built.stable).toContain("invitation_requests");
    expect(built.stable).not.toContain("2026-10-11");
    expect(built.volatile).toContain("2026-10-11T00:00:00-07:00");
  });

  it("includes the parts in every prompt path (preview, direct turn incl. routines, room turn)", () => {
    // The three prompt arrays are built inline in server/index.ts; routine
    // runs share the direct-turn path (startTurn → buildSystemPrompt), so
    // three spreads cover direct, room, routine, and preview alike.
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    for (const spread of ["...previewRelayParts", "...turnRelayParts", "...roomRelayParts"]) {
      expect(source).toContain(spread);
    }
    const uses = source.match(/relayPromptParts\(teamMidnightIso\(new Date\(\), \w+\)/g) ?? [];
    expect(uses).toHaveLength(3);
  });
});
