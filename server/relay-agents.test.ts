import { describe, expect, it } from "vitest";

import { RELAY_AGENT_SEEDS } from "./relay-agents.ts";

const scout = RELAY_AGENT_SEEDS.find((seed) => seed.role === "scout");
if (!scout) throw new Error("scout seed missing");

describe("scout capability manifest", () => {
  it("states the tool-selection policy instead of enumerating every tool", () => {
    // Tools advertise themselves (name + description via MCP); the soul only
    // sets the policy: simplest tool that works, escalate when it falls short.
    expect(scout.profile.soul).toContain("most appropriate available tool");
    expect(scout.profile.soul).toMatch(/Escalate when results are incomplete/);
    expect(scout.profile.soul).toContain("specialized connectors");
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
    // Background work waits for Relay's authorization, and the soul defers to
    // the proposal result rather than restating which threads auto-apply.
    expect(scout.profile.soul).toMatch(/never start background work before Relay authorizes it/i);
    expect(scout.profile.soul).toMatch(/applied means it is already authorized/i);
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
