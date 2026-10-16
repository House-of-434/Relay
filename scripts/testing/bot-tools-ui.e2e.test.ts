// Full-app regression through the existing disposable browser harness. No
// real provider, OAuth account, MCP package, or user data is used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { registerOwnerFetch } from "../../server/testing/owner.ts";
import { BOT_ROLES, roleProfilePatch } from "../../src/lib/bot-roles.ts";
import { runControlOmb } from "../control-relay.ts";
import { resolveUiChrome , uiE2eEnabled } from "./control-relay-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.RELAY_UI_E2E === "1";
const enabled = forced || uiE2eEnabled();
if (!enabled) console.log("skipping bot tools UI e2e: no system Chrome; set RELAY_UI_E2E=1 to require it");
const chrome = resolveUiChrome(process.env);
const LAUNCH_TIMEOUT_MS = forced && !chrome ? 600_000 : 180_000;

interface FixtureInfo { ui: string; url: string; dataDir: string; logPath: string; token: string }
interface SavedBot { id: string; name: string; soul?: string; mcpServers?: string[]; computer?: string }

describe("bot setup in the real renderer", () => {
  let child: ChildProcess | undefined;
  let info: FixtureInfo;
  afterAll(async () => {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("creates roles and recovers a rejected preset", async () => {
    let stdout = "";
    let stderr = "";
    // Windows kill("SIGINT") terminates immediately instead of delivering a
    // catchable signal. Ask the disposable launcher to run its normal cleanup.
    const launcher = new URL("./control-relay-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi([]); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS + 120_000, interval: 250 }).toBe(true);
    registerOwnerFetch(info.url, info.token);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then((response) => response.json())).bots;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const openTools = async () => {
      // Row actions reveal on hover; the bot settings dialog holds Access.
      const state = await ui("snapshot", "--interactive");
      const row = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .find(([, entry]) => entry.role === "button" && entry.name.startsWith("Pepper"));
      expect(row).toBeDefined();
      await ui("hover", "--ref", `@${row![0]}`);
      await click("Actions for Pepper");
      await click("Edit Profile");
      await click("Access");
    };
    const chooseRole = async (roleId: string) => {
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("Starting role");
      await evaluate(`(() => {
        const select = [...document.querySelectorAll('[role=dialog] select')].find(el => [...el.options].some(option => option.value === ${JSON.stringify(roleId)}));
        if (!select || select.disabled) throw new Error("Starting role is unavailable");
        select.value = ${JSON.stringify(roleId)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    };
    const dialogCount = () => evaluate("document.querySelectorAll('[role=dialog]').length");
    const original = await bots();
    const coder = BOT_ROLES.find((role) => role.id === "coder")!;

    // Hold creation in this disposable browser to exercise a close/reopen
    // while the request is pending, not just two clicks in one dialog.
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.botCreateRequests = 0;
      window.fetch = (input, init) => {
        if (String(input) === '/api/bots' && init?.method === 'POST') {
          window.botCreateRequests++;
          return new Promise(resolve => {
            window.releaseBotCreation = () => { window.fetch = fetch; resolve(fetch(input, init)); };
          });
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    await press("Control+n");
    await chooseRole(coder.id);
    expect(await evaluate("window.botCreateRequests")).toBe(0);
    await click("Create bot");
    await expect.poll(() => evaluate("window.botCreateRequests"), { timeout: 10_000 }).toBe(1);
    await press("Escape");
    expect(await dialogCount()).toBe(0);
    await press("Control+n");
    expect(await evaluate("document.querySelector('[role=dialog]')?.getAttribute('aria-busy')")).toBe("true");
    expect(await evaluate("[...document.querySelectorAll('[role=dialog] fieldset button, [role=dialog] input, [role=dialog] select, [role=dialog] textarea')].every(b => b.matches(':disabled'))")).toBe(true);
    await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Create bot')).click()");
    expect(await evaluate("window.botCreateRequests")).toBe(1);
    // Close remains usable; a slow server must not trap the user in a modal.
    await click("Close");
    expect(await dialogCount()).toBe(0);
    await press("Control+n");
    await evaluate("window.releaseBotCreation(); true");
    await expect.poll(async () => (await bots()).find((bot) => bot.name === coder.name)?.soul, { timeout: 10_000 }).toBe(coder.soul);
    const created = (await bots()).filter((bot) => !original.some((old) => old.id === bot.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject(roleProfilePatch(coder));
    expect(created[0].computer).toBe(original[0].computer);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog]')?.getAttribute('aria-busy')"), { timeout: 10_000 }).toBe("false");
    // The old dialog's callback must not close this newer dialog instance.
    expect(await dialogCount()).toBe(1);
    await press("Escape");
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);

    // Give the selected disposable bot real usage so its header shortcut
    // exercises the same external open action as the shipped chat header.
    await runControlOmb(["send", "--bot", created[0].id, "--text", "Reply briefly for the sidebar test.", "--url", info.url]);
    expect((await runControlOmb(["wait", "--bot", created[0].id, "--timeout", "20", "--url", info.url]) as { status: string }).status).toBe("settled");
    await openTools();
    // Custom MCP servers were retired: the Access section holds Google
    // connections, webhooks and always-allowed tools instead.
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Always allowed");
    // Usage lives in app settings now (the header cost chip is gone): the
    // section opens with per-bot cost copy, and Escape in its search clears
    // a stale query instead of closing the modal.
    await press("Escape");
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);
    await click("You");
    await click("Settings");
    await click("Usage");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Tokens and cost per bot");
    const search = await ui("snapshot", "--interactive");
    const searchRef = Object.entries(search.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Search settings");
    expect(searchRef).toBeDefined();
    await ui("type", "--ref", `@${searchRef![0]}`, "--text", "standing");
    expect(await evaluate("document.querySelector('[aria-label=\"Search settings\"]')?.value")).toBe("standing");
    await press("Escape"); // the search has focus from typing: clears, stays open
    expect(await evaluate("document.querySelector('[aria-label=\"Search settings\"]')?.value")).toBe("");
    expect(await snapshot()).toContain("Tokens and cost per bot");
    await ui("screenshot", "--out", `${info.logPath}.settings.png`);

    // Opening New Bot above settings must replace the old modal, not leave
    // two focus traps competing. Escape closes only the one remaining layer.
    await press("Control+n");
    expect(await dialogCount()).toBe(1);
    await press("Shift+Tab");
    expect(await evaluate("document.querySelector('[role=dialog]')?.contains(document.activeElement)")).toBe(true);
    await press("Tab");
    expect(await evaluate("document.querySelector('[role=dialog]')?.contains(document.activeElement)")).toBe(true);
    await press("Escape");
    expect(await dialogCount()).toBe(0);

    // A failed profile step must roll back the incomplete bot and leave the
    // editable draft available for a single successful retry.
    const beforeFailure = await bots();
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const path = input instanceof Request ? input.url : String(input);
        if (init?.method === 'PATCH' && /\\/api\\/bots\\/[^/]+$/.test(path) && typeof init.body === 'string' && JSON.parse(init.body).soul) {
          window.fetch = fetch;
          return Promise.resolve(new Response(JSON.stringify({error:'Fixture preset rejected'}), {status:409, headers:{'content-type':'application/json'}}));
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    // The coder role needs no connected apps, so its profile PATCH is what
    // the fixture rejects below (ops would stop at an apps confirm first).
    const retryRole = BOT_ROLES.find((role) => role.id === "coder")!;
    await press("Control+n");
    await chooseRole(retryRole.id);
    await click("Create bot");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Fixture preset rejected");
    expect((await bots()).map(bot => bot.id)).toEqual(beforeFailure.map(bot => bot.id));
    expect(await dialogCount()).toBe(1);
    await click("Create bot");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeFailure.length + 1);
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);
    expect((await bots()).filter(bot => !beforeFailure.some(old => old.id === bot.id))).toMatchObject([{ name: retryRole.name, soul: retryRole.soul }]);
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((entry) => entry.type === "error")).toEqual([]);
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
  }, LAUNCH_TIMEOUT_MS + 300_000);
});
