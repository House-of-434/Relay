import { readFileSync } from "node:fs";
import { join } from "node:path";

import { installSeedSkill, listSkills, replaceSeedSkill } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";

/** Shipped skill seeds. The id is stored on the bot after a successful
 * install or a deliberate skip, so deleting a seeded skill never makes it
 * reappear on the next restart. */
export const REPO_CHANGES_SEED = "repo-changes@4";
const REPO_CHANGES_SOURCE = "relay:seed:repo-changes@4";
const REPO_CHANGES_SOURCE_PREFIX = "relay:seed:repo-changes@";

function skillsRoot(): string {
  return process.env.RELAY_SKILLS_DIR?.trim() || join(process.cwd(), "skills");
}

function repoChangesMarkdown(): string | null {
  try {
    return readFileSync(join(skillsRoot(), "repo-changes", "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** Install or upgrade the shipped repository skill on Scout. A same-name
 * skill the person imported or learned themselves is left alone and marked
 * skipped; a previous Relay seed is replaced in place. */
export function seedScoutSkills(store: Store, bot: BotRecord): boolean {
  if (bot.relayAgent !== "scout") return true;
  if ((bot.seededSkills ?? []).includes(REPO_CHANGES_SEED)) return true;
  const existing = listSkills(bot.id).find((skill) => skill.name === "repo-changes");
  const markdown = repoChangesMarkdown();
  if (!markdown) {
    console.warn("[seed-skills] repo-changes/SKILL.md is missing; Scout was not seeded");
    return false;
  }
  if (existing) {
    // A person's own import or learned skill always wins. A previous Relay
    // seed is updated in place so the workflow fix actually reaches Scout.
    if (!existing.source.startsWith(REPO_CHANGES_SOURCE_PREFIX)) {
      store.markSkillSeed(bot.id, REPO_CHANGES_SEED);
      return true;
    }
    const updated = replaceSeedSkill(bot.id, REPO_CHANGES_SOURCE, REPO_CHANGES_SOURCE_PREFIX, markdown);
    if ("error" in updated) {
      console.warn(`[seed-skills] could not update repo-changes for ${bot.id}: ${updated.error}`);
      return false;
    }
    store.markSkillSeed(bot.id, REPO_CHANGES_SEED);
    return true;
  }
  const installed = installSeedSkill(bot.id, REPO_CHANGES_SOURCE, markdown);
  if ("error" in installed) {
    console.warn(`[seed-skills] could not install repo-changes for ${bot.id}: ${installed.error}`);
    return false;
  }
  store.markSkillSeed(bot.id, REPO_CHANGES_SEED);
  return true;
}

export function seedScoutSkillsForOwner(store: Store, ownerUserId: string | undefined): boolean {
  const scout = store.bots.find((bot) => bot.relayAgent === "scout" && bot.ownerUserId === ownerUserId);
  return scout ? seedScoutSkills(store, scout) : true;
}

export function seedAllScoutSkills(store: Store): void {
  for (const bot of store.bots) {
    if (bot.relayAgent === "scout") seedScoutSkills(store, bot);
  }
}
