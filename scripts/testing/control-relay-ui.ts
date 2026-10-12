// `control-relay ui`: drive the real React renderer headlessly against the
// isolated fake-engine fixture, through a persistent headless Chrome owned
// by this harness (system Chrome via playwright-core — no downloaded
// browser, no daemon outside the fixture). One launch owns a fixture
// server, a Vite preview of the full <App/>, and one headless browser whose
// profile lives in the fixture's disposable data directory; every other verb
// attaches to that session through the handle file the launch printed.
//
// Imported by scripts/control-relay.ts, which owns HELP and the MUTATING set;
// this file touches that module's bindings only inside functions so the
// import cycle is harmless whichever file is loaded first.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ControlOmbError,
  HELP_UI,
  launchVerificationServer,
  parse,
  runControlOmb,
  type VerificationServer,
} from "../control-relay.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Gitignored, persistent scratch for the harness. */
export const UI_TOOLS_DIR = join(ROOT, ".relay-scratch", "verify-tools");
/** Verbs that change the fixture or the page; they take the explicit handle, never discovery. */
export const UI_MUTATING = new Set(["click", "type", "press", "flag", "eval"]);

const ENTRIES = {
  threads: { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated Relay Chat" },
} as const satisfies Record<string, Parameters<typeof mountPreview>[1]>;
const FAKE_MODES = ["happy", "exit-early", "hang", "malformed", "stream", "not-logged-in", "slow", "background-result"];
const SEEDED_BOT = "Pepper";
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface UiHandle {
  url: string;
  previewUrl: string;
  home: string;
  botId: string;
  logPath: string;
  /** System Chrome the driver launched with. */
  chrome: string;
  /** The Playwright driver daemon holding this handle's browser session. */
  driverUrl: string;
}

/** System Chrome for the UI driver. `CHROME_PATH` (or `GOOGLE_CHROME`) wins,
 * then the platform's well-known install locations. Null when nothing
 * resolves — the UI e2e suite skips, it never downloads a browser. */
export function resolveUiChrome(parentEnv: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = parentEnv.CHROME_PATH?.trim() || parentEnv.GOOGLE_CHROME?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const candidates: string[] = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [
        join(parentEnv["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(parentEnv["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      ]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Fail unless system Chrome resolves, with the fix attached. */
export function ensureUiChrome(parentEnv: NodeJS.ProcessEnv = process.env): string {
  const chrome = resolveUiChrome(parentEnv);
  if (!chrome) {
    throw new ControlOmbError(
      "ui runs need system Chrome and none resolves",
      "install Google Chrome, or set CHROME_PATH to its executable",
    );
  }
  return chrome;
}

interface DriverHandle {
  url: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

/** Spawn the Playwright driver daemon holding one persistent browser.
 * The caller owns the child: stop it (POST /close, then kill) when done. */
export async function startUiDriver(options: {
  chrome: string;
  home: string;
  url?: string;
  log?: (line: string) => void;
}): Promise<DriverHandle> {
  const { chrome, home } = options;
  const log = options.log ?? (() => {});
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "scripts", "testing", "ui-driver-server.ts"),
      "--chrome", chrome, "--user-data-dir", join(home, ".ui-chrome")],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let output = "";
  const ready = new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new ControlOmbError("ui driver did not start", "check that system Chrome launches headlessly on this machine")), 60_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > OUTPUT_LIMIT) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        fail(new ControlOmbError("ui driver printed too much before going ready"));
        return;
      }
      const line = output.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (line) {
        try {
          const parsed = JSON.parse(line) as { ok?: unknown; url?: unknown };
          if (parsed.ok === true && typeof parsed.url === "string") {
            clearTimeout(timer);
            done(parsed.url);
          }
        } catch { /* keep waiting for the ready line */ }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => log(`ui driver: ${String(chunk).trim()}`));
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new ControlOmbError(`could not start the ui driver: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fail(new ControlOmbError(`ui driver exited before going ready (code ${code ?? "signal"})`));
    });
  });
  const url = await ready;
  if (options.url) {
    await driverCall(url, "open", { url: options.url }, 120_000);
  }
  let stopped = false;
  return {
    url,
    child,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await driverCall(url, "close", {}, 15_000);
      } catch { /* kill below covers it */ }
      child.kill("SIGKILL");
    },
  };
}

/** One driver verb. Throws ControlOmbError with the driver's message. */
export async function driverCall(
  driverUrl: string,
  verb: "open" | "snapshot" | "click" | "type" | "press" | "eval" | "console" | "screenshot" | "wait-fn" | "wait-load" | "close",
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${driverUrl}/${verb}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ControlOmbError(
      `ui driver ${verb} did not finish within ${timeoutMs}ms`,
      "check the page with `ui screenshot` or `ui console`",
    );
  }
  if (verb === "screenshot") {
    if (!response.ok) {
      const reason = await response.text().catch(() => `status ${response.status}`);
      throw new ControlOmbError(`ui driver screenshot failed: ${reason.slice(0, 300)}`);
    }
    return { bytes: Buffer.from(await response.arrayBuffer()) };
  }
  let result: { ok?: unknown; error?: unknown } & Record<string, unknown>;
  try {
    result = (await response.json()) as typeof result;
  } catch {
    throw new ControlOmbError(`ui driver ${verb} answered non-JSON (status ${response.status})`);
  }
  if (!response.ok || result.ok !== true) {
    const reason = typeof result.error === "string" ? result.error : `status ${response.status}`;
    throw new ControlOmbError(
      `ui driver ${verb} failed: ${reason.slice(0, 300)}`,
      "take a fresh `ui snapshot`; refs change after the page updates",
    );
  }
  const { ok: _ok, ...data } = result;
  return data;
}

function loadHandle(raw: unknown, verb: string): UiHandle {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ControlOmbError(`ui ${verb} requires --ui HANDLE`, "run `ui launch` again and use the handle it prints");
  }
  const path = resolve(raw.trim());
  let handle: Partial<UiHandle>;
  try {
    handle = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ControlOmbError(`could not read the ui handle ${path}: ${error instanceof Error ? error.message : String(error)}`, "the launch that wrote it may have stopped; run `ui launch` again");
  }
  for (const key of ["url", "previewUrl", "home", "botId", "logPath", "chrome", "driverUrl"] as const) {
    if (typeof handle[key] !== "string" || !handle[key]) throw new ControlOmbError(`the ui handle ${path} lacks ${key}`, "run `ui launch` again and use the handle it prints");
  }
  if (!existsSync(handle.home!)) throw new ControlOmbError(`the ui session's data directory is gone: ${handle.home}`, "its launch was stopped; run `ui launch` again");
  return handle as UiHandle;
}

/** A verb on a dead driver would launch a fresh blank browser and drive that. */
async function requireLiveSession(handle: UiHandle): Promise<void> {
  let alive = false;
  try {
    const response = await fetch(`${handle.driverUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    alive = response.ok;
  } catch { /* dead below */ }
  if (!alive) {
    throw new ControlOmbError(`the ui driver for ${handle.home} is not running`, "its launch was stopped or crashed; run `ui launch` again and use the new handle");
  }
}

async function snapshot(handle: UiHandle): Promise<Record<string, unknown>> {
  return driverCall(handle.driverUrl, "snapshot", {});
}

/** How long `--name` waits for its element to be rendered before giving up. */
const TARGET_WAIT_MS = 5_000;

/** `--ref @eN` verbatim, or the one element whose accessible name is `--name`. */
async function resolveTarget(handle: UiHandle, values: Record<string, unknown>, verb: string): Promise<{ target: string; name?: string }> {
  const ref = typeof values.ref === "string" ? values.ref.trim() : "";
  const name = typeof values.name === "string" ? values.name : "";
  if (Boolean(ref) === Boolean(name)) throw new ControlOmbError(`ui ${verb} needs exactly one of --ref @eN or --name NAME`);
  if (ref) {
    if (!/^@?e\d+$/.test(ref)) throw new ControlOmbError(`--ref must look like @e12, got ${JSON.stringify(ref)}`, "refs come from `ui snapshot`");
    return { target: ref.startsWith("@") ? ref : `@${ref}` };
  }
  // An element appears when React renders it, not when the previous command
  // returned, so a single snapshot races the UI: the model row this drives is
  // painted from an API read, and a name looked up one tick early is simply
  // absent. Wait for it, the way every UI driver has an implicit wait — this
  // is what made the smoke fail on ~1 run in 8, always as "no element is
  // named", on four unrelated branches. Ambiguity is not a race, so two
  // matches are still reported the moment they are seen, and a name that
  // never arrives fails with the same error as before, just later.
  const deadline = Date.now() + TARGET_WAIT_MS;
  let matches: Array<[string, { name?: unknown; role?: unknown }]> = [];
  for (;;) {
    const refs = (await snapshot(handle)).refs as Record<string, { name?: unknown; role?: unknown }> | undefined;
    matches = Object.entries(refs ?? {}).filter(([, element]) => element?.name === name);
    if (matches.length === 1) return { target: `@${matches[0]![0]}`, name };
    if (matches.length > 1 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (matches.length === 0) throw new ControlOmbError(`no element is named ${JSON.stringify(name)}`, "run `ui snapshot` and use the exact accessible name, or --ref");
  throw new ControlOmbError(
    `${matches.length} elements are named ${JSON.stringify(name)}: ${matches.map(([id, element]) => `@${id} (${String(element.role)})`).join(", ")}`,
    "pass --ref to pick one",
  );
}

function parseFlagPatch(raw: unknown): { features: Record<string, boolean | number | string> } {
  const assignments = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  if (!assignments.length) throw new ControlOmbError("ui flag requires --set features.NAME=VALUE", "example: --set features.showToolCalls=true");
  const features: Record<string, boolean | number | string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const path = separator === -1 ? assignment : assignment.slice(0, separator);
    const value = separator === -1 ? "" : assignment.slice(separator + 1);
    const [scope, name, ...rest] = path.split(".");
    if (scope !== "features" || !name || rest.length || !/^[A-Za-z][\w-]*$/.test(name) || separator === -1) {
      throw new ControlOmbError(`--set must be features.NAME=VALUE, got ${JSON.stringify(assignment)}`, "example: --set features.showToolCalls=true");
    }
    features[name] = value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { features };
}

const summarizeBots = (bots: Array<Record<string, unknown>>) =>
  bots.map((bot) => ({ id: bot.id, name: bot.name, busy: bot.busy === true,
    waitingForTeammates: bot.waitingForTeammates === true, activity: bot.activity ?? null }));

/** Settled means three things at once: the seeded bot's turn ended (the shared
 * wait tool decides how), no bot in the fixture is still busy, and the page
 * shows the newest message the server has and reports network idle. */
async function waitSettle(handle: UiHandle, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const remaining = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
  const api = fixtureApi(handle.url);
  let wait: Record<string, unknown> | undefined;
  let bots: ReturnType<typeof summarizeBots> = [];
  let renderer: Record<string, unknown> = { rendered: false };
  let browser: Record<string, unknown> = { state: "unknown" };
  const state = () => ({ status: "timed-out", bots, renderer, browser, wait });
  for (;;) {
    wait = await runControlOmb(["wait", "--bot", handle.botId, "--timeout", String(Math.min(120, remaining())), "--url", handle.url]) as Record<string, unknown>;
    if (wait.status !== "settled") return { ok: false, ...state(), status: wait.status };
    bots = summarizeBots(((await api("GET", "/api/bots?messages=0")) as { bots: Array<Record<string, unknown>> }).bots);
    if (!bots.some((bot) => bot.busy || bot.waitingForTeammates)) break;
    if (Date.now() >= deadline) return { ok: false, ...state() };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The transcript rows carry data-mid; the newest text row proves the
  // renderer caught up with the server before a snapshot reads it.
  const messages = Array.isArray(wait.messages) ? wait.messages as Array<{ id?: unknown; kind?: unknown }> : [];
  const newest = [...messages].reverse().find((message) => message.kind === "text" && typeof message.id === "string");
  try {
    if (newest) {
      await driverCall(handle.driverUrl, "wait-fn", {
        js: `!!document.querySelector(${JSON.stringify(`[data-mid=${JSON.stringify(newest.id)}]`)})`,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
      }, Math.max(1_000, deadline - Date.now()) + 5_000);
      renderer = { rendered: true, lastMessageId: newest.id };
    } else {
      renderer = { rendered: true, lastMessageId: null };
    }
    const idle = await driverCall(handle.driverUrl, "wait-load", { timeoutMs: Math.max(1_000, deadline - Date.now()) }, Math.max(1_000, deadline - Date.now()) + 5_000);
    browser = { state: idle.state ?? "networkidle" };
  } catch (error) {
    return { ok: false, ...state(), error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, status: "settled", bots, renderer, browser, wait };
}

/** The `ui` verbs other than launch. Every one takes the explicit handle. */
export async function runControlOmbUi(args: string[]): Promise<unknown> {
  const [verb = "help", ...rest] = args;
  if (verb === "help" || verb === "--help" || verb === "-h") return HELP_UI;
  if (verb === "launch") {
    throw new ControlOmbError("ui launch is available only from the executable CLI", "run `node --experimental-strip-types scripts/control-relay.ts ui launch`");
  }
  const command = `ui ${verb}`;
  const ui = { ui: { type: "string" } } as const;

  if (verb === "snapshot") {
    const values = parse(command, rest, { ...ui, interactive: { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await snapshot(handle)) };
  }

  if (verb === "click" || verb === "type") {
    const values = parse(command, rest, { ...ui, ref: { type: "string" }, name: { type: "string" }, text: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const text = verb === "type" ? values.text : undefined;
    if (verb === "type" && typeof text !== "string") throw new ControlOmbError("ui type requires --text TEXT");
    await requireLiveSession(handle);
    const { target, name } = await resolveTarget(handle, values, verb);
    const data = await driverCall(handle.driverUrl, verb, verb === "click" ? { ref: target } : { ref: target, text: text as string });
    return { ok: true, target, ...(name ? { name } : {}), ...data };
  }

  if (verb === "press") {
    const values = parse(command, rest, { ...ui, keys: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.keys !== "string" || !values.keys.trim()) throw new ControlOmbError("ui press requires --keys KEYS", "example: --keys Enter or --keys Meta+k");
    await requireLiveSession(handle);
    return { ok: true, ...(await driverCall(handle.driverUrl, "press", { keys: values.keys.trim() })) };
  }

  if (verb === "screenshot") {
    const values = parse(command, rest, { ...ui, out: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.out !== "string" || extname(values.out).toLowerCase() !== ".png") throw new ControlOmbError("ui screenshot requires --out PATH.png");
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    await requireLiveSession(handle);
    const { bytes } = await driverCall(handle.driverUrl, "screenshot", {}, 60_000);
    const png = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
    writeFileSync(out, png);
    let size = 0;
    try {
      size = statSync(out).size;
    } catch { /* reported as 0 */ }
    if (!size) throw new ControlOmbError(`the ui driver wrote no screenshot: ${out}`);
    return { ok: true, path: out, bytes: size };
  }

  if (verb === "console") {
    const values = parse(command, rest, ui);
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await driverCall(handle.driverUrl, "console", {})) };
  }

  if (verb === "eval") {
    const values = parse(command, rest, { ...ui, js: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.js !== "string" || !values.js.trim()) throw new ControlOmbError("ui eval requires --js CODE");
    await requireLiveSession(handle);
    return { ok: true, ...(await driverCall(handle.driverUrl, "eval", { js: values.js })) };
  }

  if (verb === "flag") {
    const values = parse(command, rest, { ...ui, set: { type: "string", multiple: true }, "dry-run": { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    const patch = parseFlagPatch(values.set);
    if (values["dry-run"] === true) return { ok: true, dryRun: true, url: handle.url, method: "PATCH", path: "/api/config", patch };
    const config = await fixtureApi(handle.url)("PATCH", "/api/config", patch) as Record<string, unknown>;
    return { ok: true, patch, features: config.features ?? null };
  }

  if (verb === "wait-settle") {
    const values = parse(command, rest, { ...ui, timeout: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const timeout = values.timeout === undefined ? 30 : Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new ControlOmbError("--timeout must be an integer from 1 to 600");
    await requireLiveSession(handle);
    return waitSettle(handle, timeout);
  }

  throw new ControlOmbError(`unknown ui command ${JSON.stringify(verb)}`, "run control-relay ui help");
}

function parkUntilSignalOrExit(child: ChildProcess, stopRequested: () => boolean): Promise<"signal" | "exit"> {
  return new Promise((settle) => {
    if (stopRequested()) { settle("signal"); return; }
    const finish = (reason: "signal" | "exit") => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      child.off("close", onExit);
      settle(reason);
    };
    const onSignal = () => finish("signal");
    const onExit = () => finish("exit");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.once("close", onExit);
  });
}

/** `ui launch`: fixture, preview, seeded bot, browser session, handle file;
 * park until interrupted, then close the browser, the preview and the
 * fixture in that order. Only ever runs from the executable CLI. */
export async function launchUi(
  args: string[],
  parentEnv: NodeJS.ProcessEnv = process.env,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  fixtureOptions: { boatFixtureApi?: string } = {},
): Promise<void> {
  const values = parse("ui launch", args, { entry: { type: "string" }, "tool-calls": { type: "string" }, mode: { type: "string" } });
  const entryName = typeof values.entry === "string" ? values.entry : "threads";
  if (!Object.hasOwn(ENTRIES, entryName)) {
    throw new ControlOmbError(`unknown --entry ${JSON.stringify(entryName)}`, `available entries: ${Object.keys(ENTRIES).join(", ")}`);
  }
  const entry = ENTRIES[entryName as keyof typeof ENTRIES];
  const fakeEnv: NodeJS.ProcessEnv = {};
  if (values["tool-calls"] !== undefined) {
    let calls: unknown;
    try { calls = JSON.parse(String(values["tool-calls"])); } catch { calls = undefined; }
    if (!Array.isArray(calls) || !calls.every((call) => call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string")) {
      throw new ControlOmbError("--tool-calls must be a JSON array of {name, input?, ok?}", 'example: --tool-calls \'[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]\'');
    }
    fakeEnv.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify(calls);
  }
  if (values.mode !== undefined) {
    if (!FAKE_MODES.includes(String(values.mode))) throw new ControlOmbError(`unknown --mode ${JSON.stringify(values.mode)}`, `fake engine modes: ${FAKE_MODES.join(", ")}`);
    fakeEnv.FAKE_CLAUDE_MODE = String(values.mode);
  }
  const note = (line: string) => io.stderr.write(`ui launch: ${line}\n`);

  // A Ctrl-C at any point after this stops the launch at its next step and
  // still runs the cleanup below for whatever already started.
  let stopRequested = false;
  const startup = new AbortController();
  const requestStop = () => { stopRequested = true; startup.abort(); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const checkpoint = () => { if (stopRequested) throw new ControlOmbError("ui launch cancelled"); };

  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let driver: DriverHandle | undefined;
  try {
    const chrome = ensureUiChrome(parentEnv);
    checkpoint();
    fixture = await launchVerificationServer({ ...parentEnv, ...fakeEnv }, startup.signal, undefined,
      undefined, undefined, [], fixtureOptions.boatFixtureApi);
    checkpoint();
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const created = await runControlOmb(["new-bot", "--name", SEEDED_BOT, "--url", fixture.info.url]) as { bot: { id: string } };
    checkpoint();
    // stdout carries the handle and nothing else; Vite's port and dependency
    // notes would otherwise land there first.
    preview = await mountPreview(fixture, { ...entry, logLevel: "warn" });
    checkpoint();
    driver = await startUiDriver({ chrome, home: fixture.info.dataDir, url: preview.previewUrl, log: note });
    checkpoint();
    const handle: UiHandle = {
      url: fixture.info.url,
      previewUrl: preview.previewUrl,
      home: fixture.info.dataDir,
      botId: created.bot.id,
      logPath: fixture.info.logPath,
      chrome,
      driverUrl: driver.url,
    };
    const handlePath = join(fixture.info.dataDir, "ui.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(handlePath, `${JSON.stringify(handle, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`${JSON.stringify({
      ok: true, ui: handlePath, url: handle.url, previewUrl: handle.previewUrl, botId: handle.botId, dataDir: handle.home, logPath: handle.logPath,
    }, null, 2)}\n`);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    const reason = await parkUntilSignalOrExit(fixture.child, () => stopRequested);
    if (reason === "exit") {
      process.exitCode = 1;
      io.stderr.write(`${JSON.stringify({ ok: false, error: `verification server exited unexpectedly; see ${fixture.info.logPath}` }, null, 2)}\n`);
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    await driver?.stop().catch(() => {});
    await preview?.close();
    await fixture?.close();
  }
}
