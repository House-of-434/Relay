import { describe, expect, it } from "vitest";

import { RELAY_AGENT_SEEDS } from "./relay-agents.ts";

const scout = RELAY_AGENT_SEEDS.find((seed) => seed.role === "scout");
if (!scout) throw new Error("scout seed missing");

describe("scout capability manifest", () => {
  it("names every research capability the soul may direct", () => {
    for (const capability of [
      "relay_read",
      "relay_write",
      "web_search",
      "browser_open",
      "browser_read",
      "browser_extract",
    ]) {
      expect(scout.profile.soul).toContain(capability);
    }
  });

  it("defines the deep-research protocol: plan preview, confirmed one-shot", () => {
    expect(scout.profile.soul).toMatch(/plan preview/i);
    // Confirmation is its own one-shot request card: research is proposed
    // through propose_deep_research, never as a routine or a conversational
    // go-ahead.
    expect(scout.profile.soul).toContain("propose_deep_research");
    expect(scout.profile.soul).toContain("Never use propose_routine for one-shot research");
    expect(scout.profile.soul).toMatch(/once/i);
    expect(scout.profile.soul).not.toMatch(/go-ahead/i);
    // Background work must never start before the human confirms.
    expect(scout.profile.soul).toMatch(/never start background work before confirmation/i);
  });

  it("keeps the evidence taxonomy and honesty invariants", () => {
    for (const marker of [
      "do not invent",
      "source URL",
      "confidence",
      "single source",
      "permitted tables",
      "blocked page",
    ]) {
      expect(scout.profile.soul).toContain(marker);
    }
    expect(scout.profile.soul).toMatch(/corroborat/);
    expect(scout.profile.soul).toMatch(/infer/);
  });
});
