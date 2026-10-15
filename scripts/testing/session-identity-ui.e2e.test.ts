// The signed-in sidebar in the real renderer: the Google account's name and
// photo come from the one session read the boot already made, in both sidebar
// densities, and a photo that cannot load falls back to initials.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-relay.ts";
import { resolveUiChrome } from "./control-relay-ui.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const chrome = resolveUiChrome(process.env);
const forced = process.env.RELAY_UI_E2E === "1";
const enabled = forced || Boolean(chrome);
const launchTimeout = forced && !chrome ? 600_000 : 180_000;
if (!enabled) console.log("skipping session identity UI e2e: no system Chrome; set RELAY_UI_E2E=1 to require it");
const evidence = (name: string) => join(ROOT, ".relay-scratch", "verify-evidence", `session-identity-${name}.png`);

describe("Google sign-in identity in the sidebar", () => {
  let child: ChildProcess | undefined;
  let preview: MountedPreview | undefined;
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await preview?.close();
  });

  (enabled ? it : it.skip)("shows the login's name and photo in both densities, with an initials fallback", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-relay.ts"), "ui", "launch"], {
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
    const go = async (scenario: string) => {
      await evaluate(`(() => { localStorage.setItem("relay.sidebarDensity", "comfortable"); location.href = ${JSON.stringify(`${preview!.previewUrl}?scenario=${scenario}`)}; return true; })()`);
      await expect.poll(snapshot, { timeout: 20_000 }).toContain("Ada Lovelace");
    };
    // The identity row: the login's photo is loaded, not a broken image, and the
    // name is the login's name rather than the generic "You".
    const rowPhoto = () => evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('button')).find((node) => (node.getAttribute('aria-label') || '').includes('Ada Lovelace'));
      const photo = row?.querySelector('img');
      return photo ? { src: photo.src.slice(0, 30), width: photo.naturalWidth, height: photo.naturalHeight } : null;
    })()`);

    preview = await mountPreview({ info: { url: info!.url } }, {
      entry: "/scripts/testing/session-identity-preview.tsx", route: "/__session-identity.html",
      title: "Isolated Google sign-in identity", logLevel: "silent",
    });

    await go("google-photo");
    expect(await rowPhoto()).toMatchObject({ width: 128, height: 128 });
    expect(await snapshot()).not.toContain('button "You"');
    await ui("screenshot", "--out", evidence("comfortable"));

    // The compact density hides the name, so the row button itself has to
    // say who it is — the case a typed Relay name would have covered before.
    // (The old separate app-settings tile is gone; settings live in the
    // profile menu now.)
    await evaluate(`(() => { localStorage.setItem("relay.sidebarDensity", "icons"); location.reload(); return true; })()`);
    await expect.poll(snapshot, { timeout: 20_000 }).toContain('button "Ada Lovelace"');
    expect(await snapshot()).not.toContain('button "You"');
    expect(await rowPhoto()).toMatchObject({ width: 128, height: 128 });
    await ui("screenshot", "--out", evidence("icons-density"));

    // A photo the browser cannot load must not leave a broken image or an
    // error loop: the row falls back to the same initials as before.
    await go("broken-photo");
    await expect.poll(() => evaluate("!!Array.from(document.querySelectorAll('button')).find((node) => (node.getAttribute('aria-label') || '').includes('Ada Lovelace'))"), { timeout: 20_000 }).toBe(true);
    // The broken photo fails asynchronously; poll until every aside image
    // has resolved (the row falls back to initials, never a broken image).
    await expect.poll(() => evaluate("Array.from(document.querySelectorAll('aside img')).every((img) => img.complete && img.naturalWidth > 0)"), { timeout: 20_000 }).toBe(true);
    await ui("screenshot", "--out", evidence("broken-photo-initials"));
  }, launchTimeout + 120_000);
});