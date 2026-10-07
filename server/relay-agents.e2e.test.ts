import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

it("boots an idempotent Scout, Mercury, Curator roster using the current default model", async () => {
  const fixture = await launchVerificationServer({
    ...process.env,
    RELAY_SHARED_WORKSPACE: "1",
    RELAY_TOOL_URL: "http://127.0.0.1:8787",
  });
  try {
    const response = await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers: { origin: fixture.info.url } });
    expect(response.status).toBe(200);
    const { bots } = await response.json() as { bots: Array<Record<string, any>> };
    expect(bots.map((bot) => bot.name).sort()).toEqual(["Curator", "Mercury", "Scout"]);
    expect(new Set(bots.map((bot) => bot.id)).size).toBe(3);
    expect(bots.every((bot) => bot.computer === "off" && bot.browser === false && bot.composio === false)).toBe(true);
    expect(new Set(bots.map((bot) => `${bot.modelSelection.instanceId}:${bot.modelSelection.model}`)).size).toBe(1);
    // The role reaches the wire so the UI can offer Scout-only affordances
    // from server truth; it stays a role name, never the editable persona.
    expect(bots.map((bot) => bot.relayAgent).sort()).toEqual(["curator", "mercury", "scout"]);

    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ relayAgent?: string }>;
    expect(saved.map((bot) => bot.relayAgent).sort()).toEqual(["curator", "mercury", "scout"]);
    expect((await fetch(`${fixture.info.url}/api/config`, { headers: { origin: fixture.info.url } })).status).toBe(200);
  } finally {
    await fixture.close();
  }
}, 90_000);
