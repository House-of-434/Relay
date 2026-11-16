import { describe, expect, it } from "vitest";

import { seedScoutSkills } from "./seed-skills.ts";
import { listSkills } from "./skills.ts";
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

    expect(marked).toEqual(["repo-changes@1"]);
    expect(listSkills(bot.id)).toMatchObject([
      { name: "repo-changes", enabled: true, source: "relay:seed:repo-changes@1" },
    ]);
  });
});
