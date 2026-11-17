import { describe, expect, it } from "vitest";

import { installSeedSkill, setSkillEnabled } from "./skills.ts";
import { REPO_CHANGES_SEED, seedScoutSkills } from "./seed-skills.ts";
import { listSkills, readSkillFile } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";

describe("shipped Scout skill seed", () => {
  it("installs repo-changes enabled once and records the seed marker", () => {
    const bot = {
      id: `seed-bot-${Math.random().toString(36).slice(2, 10)}`,
      relayAgent: "scout",
      seededSkills: [],
    } as unknown as BotRecord;
    const marked: string[] = [];
    const store = {
      bots: [bot],
      markSkillSeed: (_botId: string, seed: string) => { marked.push(seed); },
    } as unknown as Store;

    seedScoutSkills(store, bot);

    expect(marked).toEqual([REPO_CHANGES_SEED]);
    expect(listSkills(bot.id)).toMatchObject([
      { name: "repo-changes", enabled: true, source: "relay:seed:repo-changes@2" },
    ]);
  });

  it("updates a previous Relay seed in place and keeps it disabled", async () => {
    const bot = {
      id: `seed-bot-${Math.random().toString(36).slice(2, 10)}`,
      relayAgent: "scout",
      seededSkills: [],
    } as unknown as BotRecord;
    const marked: string[] = [];
    const store = {
      bots: [bot],
      markSkillSeed: (_botId: string, seed: string) => { marked.push(seed); },
    } as unknown as Store;

    installSeedSkill(bot.id, "relay:seed:repo-changes@1", "---\nname: repo-changes\ndescription: Old workflow\n---\n\nOld workflow.");
    const old = listSkills(bot.id)[0]!;
    // Seed installs enabled by default; turn it off to prove the upgrade
    // preserves the person's choice.
    setSkillEnabled(bot.id, "repo-changes", false);

    seedScoutSkills(store, bot);

    expect(marked).toEqual([REPO_CHANGES_SEED]);
    expect(listSkills(bot.id)).toMatchObject([
      { name: "repo-changes", enabled: false, source: "relay:seed:repo-changes@2" },
    ]);
    expect(readSkillFile(bot.id, "repo-changes")).toContain("github_open_pull_request");
    expect(old.source).toBe("relay:seed:repo-changes@1");
  });

  it("leaves a person's own skill with the same name alone", () => {
    const bot = {
      id: `seed-bot-${Math.random().toString(36).slice(2, 10)}`,
      relayAgent: "scout",
      seededSkills: [],
    } as unknown as BotRecord;
    const marked: string[] = [];
    const store = {
      bots: [bot],
      markSkillSeed: (_botId: string, seed: string) => { marked.push(seed); },
    } as unknown as Store;

    installSeedSkill(bot.id, "user:import", "---\nname: repo-changes\ndescription: Mine\n---\n\nMine.");
    seedScoutSkills(store, bot);

    expect(marked).toEqual([REPO_CHANGES_SEED]);
    expect(listSkills(bot.id)).toMatchObject([
      { name: "repo-changes", source: "user:import" },
    ]);
  });
});
