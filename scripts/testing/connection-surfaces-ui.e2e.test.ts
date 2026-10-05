// The two connection surfaces in the real renderer: the Connections
// marketplace and the Settings → Servers card. Only the Google connection
// inventory and the desktop's saved-servers bridge are simulated; the panels,
// the store, the confirm dialog and every fetch below them are the shipping
// code.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping connection surfaces UI e2e: no agent-browser; set OMB_UI_E2E=1 to install the pinned release");
const evidence = (name: string) => join(ROOT, ".omb-scratch", "verify-evidence", `connection-surfaces-${name}.png`);

/** Answers the connections inventory from the page, recording every revoke.
 *  Plain objects, not Response: the revokes are the interesting evidence. */
const GOOGLE_FIXTURE = `(() => {
  const accounts = [
    { service: "gmail", id: "ca_ada_mail", email: "ada@houseof434.com" },
    { service: "gmail", id: "ca_ada_work", email: "ada.work@houseof434.com" },
    { service: "google-calendar", id: "ca_ada_cal", email: "ada@houseof434.com" }
  ];
  const deletes = [];
  const original = window.fetch.bind(window);
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  window.fetch = async (input, init = {}) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = (init.method || "GET").toUpperCase();
    if (method === "DELETE" && path.startsWith("/api/google/connections/")) {
      const [, , , , service, id] = path.split("/");
      deletes.push(service + ":" + id);
      const at = accounts.findIndex((a) => a.service === service && a.id === id);
      if (at >= 0) accounts.splice(at, 1);
      return reply({});
    }
    if (path === "/api/google/connections") return reply({ accounts: [...accounts], services: { gmail: true, "google-calendar": true } });
    return original(input, init);
  };
  window.confirm = (message) => { window.googleFixtureConfirm = message; return true; };
  window.googleFixture = { accounts, deletes };
  return true;
})()`;

/** A saved-servers bridge that answers on command: `mode` picks whether the
 *  privileged list read succeeds, hangs or refuses. */
const SERVERS_FIXTURE = `(() => {
  const calls = [];
  const saved = { activeId: "local", environments: [
    { id: "srv_ada", name: "Ada's VPS", origin: "https://relay.ada.houseof434.com" },
    { id: "srv_lab", name: "Lab", origin: "https://lab.houseof434.com" }
  ] };
  window.ogb = Object.assign(window.ogb || {}, {
    environments: {
      state: async () => {
        calls.push("state");
        const mode = window.serversMode;
        if (mode === "hang") return new Promise(() => {});
        if (mode === "fail") throw new Error("the privileged read refused");
        return structuredClone(saved);
      },
      switch: async (id) => { calls.push("switch:" + id); },
      forget: async (id) => { calls.push("forget:" + id); saved.environments = saved.environments.filter((e) => e.id !== id); },
      addFromLink: async (link, name) => { calls.push("add:" + link + ":" + name); },
      onOpenSettings: () => () => {}
    }
  });
  window.serversFixture = { calls, saved };
  window.serversMode = "ok";
  return true;
})()`;

describe("Connections marketplace and the Servers settings card", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("offers one Disconnect per service and marketplace-style server rows", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error: Error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const clickText = (label: string) => evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((n) => n.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error("no button " + ${JSON.stringify(label)}); b.click(); return true; })()`);
    const openPanel = async () => {
      await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((n) => n.textContent.trim().startsWith('Tools')); b.click(); return true; })()`);
      await clickText("Connections");
    };
    const closePanel = async () => evaluate(`(() => { document.querySelector('[data-tour="apps-close"]').click(); return true; })()`);
    const tab = (label: string) => evaluate(`(() => { Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.includes(${JSON.stringify(label)})).click(); return true; })()`);
    const panel = () => evaluate(`document.querySelector('[data-tour="apps-panel"]')?.innerText ?? null`);
    const rows = () => evaluate(`Array.from(document.querySelectorAll('[data-tour="apps-panel"] button')).map((b) => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean)`);

    await expect.poll(snapshot, { timeout: 20_000 }).toContain("New or share");

    // Nothing connected: both Google services are offered with the permission
    // boundary each grant actually carries, and the Connected tab is empty of
    // any count.
    await openPanel();
    await expect.poll(panel, { timeout: 10_000 }).toContain("Relay can read and search your mail");
    expect(await panel()).toContain("Relay can read your primary calendar and manage its events");
    // Each row offers its one action: Connect, or the honest reason it is not
    // available yet on a machine with no Google client configured.
    expect((await rows()).filter((label) => /^(Connect|Coming soon)$/.test(label)).length).toBe(2);
    expect(await evaluate(`Array.from(document.querySelectorAll('[data-tour="apps-panel"] svg path')).filter((p) => /#EA4335|#4285F4/.test(p.getAttribute('fill') || '')).length`)).toBe(2);
    await ui("screenshot", "--out", evidence("connections-available"));
    await closePanel();

    // Two grants on one service: one row, no account or token lines, and the
    // Disconnect belongs to the service rather than to a single account.
    await evaluate(GOOGLE_FIXTURE);
    await openPanel();
    await tab("Connected");
    await expect.poll(panel, { timeout: 10_000 }).toContain("Disconnect");
    expect(await panel()).not.toContain("ca_ada_mail");
    expect(await panel()).not.toContain("ada@houseof434.com");
    expect(await panel()).not.toContain("Add account");
    expect(await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).map((n) => n.textContent.trim())`)).toEqual(["Available", "Connected"]);
    await ui("screenshot", "--out", evidence("connections-connected"));

    await evaluate(`(() => { document.querySelector('[data-tour="apps-panel"] button[aria-label="Disconnect Gmail from Relay"]').click(); return true; })()`);
    await expect.poll(() => evaluate("window.googleFixture.deletes.length"), { timeout: 10_000 }).toBe(2);
    // Both Gmail grants are revoked and the calendar grant is untouched, so the
    // confirmation the user accepted ("Relay will lose access to your Gmail
    // data") is what actually happened.
    expect(await evaluate("window.googleFixture.deletes")).toEqual(["gmail:ca_ada_mail", "gmail:ca_ada_work"]);
    expect(await evaluate("window.googleFixture.accounts.map((a) => a.service)")).toEqual(["google-calendar"]);
    expect(await evaluate("window.googleFixtureConfirm")).toBe("Disconnect Gmail? Relay will lose access to your Gmail data until you connect again.");
    await closePanel();

    // The Servers card: a logo tile and a status pill per row, a spinner while
    // the privileged list is in flight, and its own failure sentence with a
    // Retry that recovers.
    await evaluate(SERVERS_FIXTURE);
    await evaluate(`document.querySelector('button[aria-label="You"]').click(); true`);
    await clickText("Settings");
    await clickText("Servers");
    await expect.poll(() => evaluate(`document.querySelector('[role=dialog]').innerText`), { timeout: 10_000 }).toContain("This computer");
    // A logo tile per row: the local one is this app's icon, and a saved server
    // that cannot serve its own falls back to a letter rather than an empty box.
    await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('[role=dialog] li')).map((row) => row.querySelector('img') ? 'logo-tile' : 'letter-tile')`), { timeout: 10_000 })
      .toEqual(["logo-tile", "letter-tile", "letter-tile"]);
    expect(await evaluate(`Array.from(document.querySelectorAll('[role=dialog] span')).filter((n) => n.textContent.trim() === 'Current').length`)).toBe(1);
    await ui("screenshot", "--out", evidence("servers-rows"));

    // A list read that never lands leaves a spinner, not an empty card.
    await evaluate(`(() => { window.serversMode = "hang"; document.querySelector('[role=dialog] button[aria-label="Close settings"]').click(); return true; })()`);
    await evaluate(`document.querySelector('button[aria-label="You"]').click(); true`);
    await clickText("Settings");
    await clickText("Servers");
    await expect.poll(() => evaluate(`document.querySelector('[role=dialog]').innerText`), { timeout: 10_000 }).toContain("Loading servers");
    await ui("screenshot", "--out", evidence("servers-loading"));

    // A list read that fails says so on its own terms and offers Retry, which
    // brings the rows back once the bridge answers.
    await evaluate(`(() => { window.serversMode = "fail"; document.querySelector('[role=dialog] button[aria-label="Close settings"]').click(); return true; })()`);
    await evaluate(`document.querySelector('button[aria-label="You"]').click(); true`);
    await clickText("Settings");
    await clickText("Servers");
    await expect.poll(() => evaluate(`document.querySelector('[role=dialog]').innerText`), { timeout: 10_000 }).toContain("Saved servers could not be loaded.");
    await ui("screenshot", "--out", evidence("servers-load-failed"));
    await evaluate(`window.serversMode = "ok"; true`);
    await clickText("Retry");
    await expect.poll(() => evaluate(`document.querySelector('[role=dialog]').innerText`), { timeout: 10_000 }).toContain("Ada's VPS");

    // A forget that works, whose read-back then refuses, must say the list may
    // be stale rather than leave a row that looks un-forgotten.
    await evaluate(`(() => { const real = window.ogb.environments.forget; window.ogb.environments.forget = async (id) => { await real(id); window.serversMode = "fail"; }; return true; })()`);
    await evaluate(`(() => { document.querySelector('button[aria-label="Forget Lab"]').click(); return true; })()`);
    await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('[role=alert]')).map((n) => n.textContent)`), { timeout: 10_000 })
      .toEqual(["Saved servers could not be refreshed."]);
    expect(await evaluate("window.serversFixture.calls")).toContain("forget:srv_lab");
  });
});