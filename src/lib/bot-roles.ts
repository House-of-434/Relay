// Starting points for a new bot. A role is a name, a job, standing
// instructions — enough that the bot can start working (or run /setup to
// interview you) instead of arriving
// blank. The user-facing library of whole teams lives in the Team library;
// this is the single-bot shortlist shown at creation.

export interface BotRole {
  id: string;
  /** Default bot name; the user renames freely. */
  name: string;
  title: string;
  description: string;
  /** SOUL.md-style standing instructions. */
  soul: string;
  /** Connected-app slugs the role usually wants; shown as hints, never
   * connected automatically. */
  apps: string[];
}

export const BOT_ROLES: BotRole[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "General assistant",
    description: "Answers questions, drafts text, and takes on whatever you hand it.",
    soul: "You are a capable, plain-spoken assistant. Ask one clarifying question when a request is ambiguous; otherwise do the work and show the result. Keep replies short and concrete.",
    apps: [],
  },
  {
    id: "coder",
    name: "Dev",
    title: "Coding partner",
    description: "Works inside a project folder: reads, edits, runs tests, explains changes.",
    soul: "You are a careful engineer working in the user's project folder. Read before you edit. Run the project's tests after changes and report the real output. Keep diffs small and explain what changed and why. Never push, publish, or delete branches unless told to.",
    apps: ["github"],
  },
  {
    id: "community",
    name: "Watch",
    title: "Community monitor",
    description: "Watches Discord, Slack, or forums and reports what matters, on a schedule.",
    soul: "You monitor the user's community channels. Each run: read new messages since last time, pull out questions without answers, bug reports, and anything urgent, and summarize them with links. Never post or reply in the channels yourself; you report to the user.",
    apps: ["discord", "slack"],
  },
];

export function botRole(id: string): BotRole | undefined {
  return BOT_ROLES.find((role) => role.id === id);
}

/** The PATCH body that turns a freshly created blank bot into this role. */
export function roleProfilePatch(role: BotRole): {
  name: string;
  title: string;
  description: string;
  soul: string;
} {
  return {
    name: role.name,
    title: role.title,
    description: role.description,
    soul: role.soul,
  };
}
