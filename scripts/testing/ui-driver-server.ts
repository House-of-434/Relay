// Headless-Chrome UI driver for the verification harness (`control-relay ui`
// verbs and the UI e2e suite). Replaces the removed agent-browser binary:
// one persistent Chromium (system Chrome via playwright-core) behind a tiny
// loopback HTTP API, so separate CLI invocations share a single browser
// session with live page state (fetch interceptors, dialogs, typed text).
//
// Run: node --experimental-strip-types scripts/testing/ui-driver-server.ts
//   --chrome PATH --user-data-dir DIR [--port N]
// Prints {"ok":true,"url":"http://127.0.0.1:PORT"} on stdout once ready,
// then serves until POST /close or SIGINT/SIGTERM.
//
// Snapshot refs (@eN) are synthesized per snapshot from a DOM walk: each
// actionable element gets an id and a CSS path. Refs are valid until the
// next snapshot — a click/type on an unknown ref re-snapshots once, the
// same contract agent-browser documented ("refs change after the page
// updates; take a fresh snapshot").
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`ui-driver: ${message}\n`);
  process.exit(1);
}

const chromePath = arg("--chrome");
const userDataDir = arg("--user-data-dir");
if (!chromePath) fail("missing --chrome PATH");
if (!userDataDir) fail("missing --user-data-dir");

interface AxEntry {
  id: string;
  role: string;
  name: string;
  path: string;
}

interface CollectedNode {
  role: string;
  name: string;
  path: string;
  depth: number;
}

const COLLECT_JS = `(() => {
  const MAX_NAME = 200;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const IMPLICIT_ROLE = {
    A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox",
    TEXTAREA: "textbox", IMG: "img", H1: "heading", H2: "heading", H3: "heading",
    H4: "heading", H5: "heading", H6: "heading",
  };
  const INPUT_ROLE = {
    button: "button", submit: "button", reset: "button", checkbox: "checkbox",
    radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
  };
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 12) {
      const tag = node.tagName.toLowerCase();
      let index = 1, sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      // Always qualify: an unqualified tag matches every same-tag sibling
      // (strict-mode violation) instead of this node.
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    parts.unshift("body");
    return parts.join(" > ");
  }
  function labelledByText(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").trim().split(new RegExp("[ \\t\\n\\r]+")).filter(Boolean);
    if (!ids.length) return "";
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(new RegExp("[ \\t\\n\\r]+", "g"), " ").trim();
  }
  function textOf(el) {
    return (el.textContent ?? "").replace(new RegExp("[ \\t\\n\\r]+", "g"), " ").trim();
  }
  // Accessible-name priority per the accName spec: labelledby and label
  // first, then content for roles named by their contents, with title only
  // as a last resort (a button's title must never shadow its visible text).
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "option", "treeitem", "cell", "rowheader", "columnheader", "switch",
  ]);
  function nameOf(el, role) {
    return (
      (el.getAttribute("aria-label") || "").trim() ||
      labelledByText(el) ||
      (el.tagName === "IMG" ? (el.getAttribute("alt") || "").trim() : "") ||
      (NAME_FROM_CONTENT.has(role) ? textOf(el) : "") ||
      (el.getAttribute("title") || "").trim() ||
      ""
    ).slice(0, MAX_NAME);
  }
  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().toLowerCase().split(new RegExp("[ \\t\\n\\r]+"))[0];
    if (explicit) return explicit;
    if (el.isContentEditable) return "textbox";
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLE[type] ?? "textbox";
    }
    return IMPLICIT_ROLE[tag] ?? "";
  }
  const out = [];
  const push = (el, role, name) => {
    let d = 0;
    let p = el.parentElement;
    while (p && p !== document.body) { d += 1; p = p.parentElement; }
    out.push({ role, name, path: cssPath(el), depth: Math.min(d, 12) });
  };
  // An element's own direct text (not its descendants'): leaf labels like a
  // model name inside a larger button. agent-browser's AX tree exposed these
  // text nodes, and --name matches them exactly.
  const ownText = (el) => {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.replace(new RegExp("[ \\t\\n\\r]+", "g"), " ").trim().slice(0, MAX_NAME);
  };
  // Hidden duplicates (a mobile variant, a closed menu) would make --name
  // ambiguous where the accessibility tree sees one element. Skip
  // aria-hidden subtrees and anything with no rendered box.
  const visit = (el) => {
    if (SKIP.has(el.tagName)) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return;
    const rect = el.getBoundingClientRect();
    const rendered = rect.width > 0 || rect.height > 0;
    const role = roleOf(el);
    if (rendered && role && role !== "generic") {
      push(el, role, nameOf(el, role));
    } else if (rendered && el.children.length === 0) {
      const text = ownText(el);
      if (text) push(el, "text", text);
    }
    for (const child of el.children) visit(child);
  };
  visit(document.body);
  return out;
})()`;

interface SnapshotEntry extends CollectedNode {
  id: string;
}

function collectEntries(nodes: CollectedNode[]): SnapshotEntry[] {
  // A text leaf that merely repeats an actionable element's exact name would
  // make --name ambiguous (e.g. a "You" label inside a "You" button). Keep
  // only text that adds information, like a model name inside a longer row.
  const named = new Set(
    nodes.filter((node) => node.role !== "text" && node.name).map((node) => `${node.role}::${node.name}`),
  );
  const kept = nodes.filter((node) => node.role !== "text" || node.name === "" || ![...named].some((key) => key.endsWith(`::${node.name}`)));
  return kept.map((node, i) => ({ ...node, id: `e${i + 1}` }));
}

function renderSnapshot(entries: SnapshotEntry[]): { snapshot: string; refs: Record<string, { name: string; role: string }> } {
  const refs: Record<string, { name: string; role: string }> = {};
  const lines = entries.map((node) => {
    refs[node.id] = { name: node.name, role: node.role };
    return `${"  ".repeat(node.depth)}- ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ""} [ref=${node.id}]`;
  });
  return { snapshot: lines.join("\n"), refs };
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page: Page = await context.newPage();
  let refs = new Map<string, AxEntry>();
  const consoleMessages: Array<{ type: string; text: string }> = [];
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text().slice(0, 4000) });
    if (consoleMessages.length > 200) consoleMessages.splice(0, consoleMessages.length - 200);
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({ type: "error", text: String(error?.message ?? error).slice(0, 4000) });
    if (consoleMessages.length > 200) consoleMessages.splice(0, consoleMessages.length - 200);
  });

  async function takeSnapshot(): Promise<{ snapshot: string; refs: Record<string, { name: string; role: string }> }> {
    // (shape verified against the e2e contract: { snapshot, refs })
    const nodes = (await page.evaluate(COLLECT_JS)) as CollectedNode[];
    const entries = collectEntries(nodes);
    refs = new Map(entries.map((node) => [node.id, { id: node.id, role: node.role, name: node.name, path: node.path }]));
    return renderSnapshot(entries);
  }

  /** A fresh CSS path for a ref, resolved at action time: re-snapshot and
   * prefer the element with the same role+name, so re-renders between
   * snapshot and click cannot send the action to a stale node. Retries
   * briefly for elements that appear a tick later (settings panels load
   * async); falls back to the recorded path when the match is ambiguous
   * or gone. */
  async function locatorFor(ref: string): Promise<string> {
    const id = ref.startsWith("@") ? ref.slice(1) : ref;
    const entry = refs.get(id);
    if (!entry) {
      await takeSnapshot();
      const retry = refs.get(id);
      if (!retry) throw new Error(`unknown ref ${ref}; take a fresh ui snapshot — refs change after the page updates`);
      return locatorFor(`@${id}`);
    }
    if (entry.name && entry.role !== "text") {
      const deadline = Date.now() + 5_000;
      for (;;) {
        await takeSnapshot();
        const matches = [...refs.values()].filter((node) => node.role === entry.role && node.name === entry.name);
        if (matches.length === 1) return matches[0]!.path;
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(150);
      }
    }
    return entry.path;
  }

  function readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += String(chunk);
        if (raw.length > 4 * 1024 * 1024) reject(new Error("request body too large"));
      });
      request.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new Error("request body must be JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      try {
        if (request.method === "GET" && url.pathname === "/health") {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
          return;
        }
        const body = (await readBody(request)) as Record<string, unknown>;
        switch (url.pathname) {
          case "/open": {
            const target = body.url;
            if (typeof target !== "string" || !target) throw new Error("open requires a url");
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: 120_000 });
            sendJson(response, 200, { ok: true });
            return;
          }
          case "/snapshot": {
            sendJson(response, 200, { ok: true, ...(await takeSnapshot()) });
            return;
          }
          case "/click": {
            const path = await locatorFor(String(body.ref ?? ""));
            await page.locator(path).click({ timeout: 10_000 });
            sendJson(response, 200, { ok: true });
            return;
          }
          case "/type": {
            const path = await locatorFor(String(body.ref ?? ""));
            const text = body.text;
            if (typeof text !== "string") throw new Error("type requires text");
            await page.locator(path).fill(text, { timeout: 10_000 });
            sendJson(response, 200, { ok: true });
            return;
          }
          case "/press": {
            const keys = body.keys;
            if (typeof keys !== "string" || !keys.trim()) throw new Error("press requires keys");
            await page.keyboard.press(keys.trim(), { delay: 0 });
            // Let React process the keystroke before the next verb reads state.
            await page.waitForTimeout(150);
            sendJson(response, 200, { ok: true });
            return;
          }
          case "/eval": {
            const js = body.js;
            if (typeof js !== "string" || !js.trim()) throw new Error("eval requires js");
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const result = await page.evaluate(js);
            sendJson(response, 200, result === undefined ? { ok: true } : { ok: true, result });
            return;
          }
          case "/console": {
            sendJson(response, 200, { ok: true, messages: consoleMessages.slice(-100) });
            return;
          }
          case "/screenshot": {
            const png = await page.screenshot({ type: "png", timeout: 60_000 });
            response.writeHead(200, { "content-type": "image/png", "content-length": png.length });
            response.end(png);
            return;
          }
          case "/wait-fn": {
            const js = body.js;
            if (typeof js !== "string" || !js.trim()) throw new Error("wait-fn requires js");
            const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 30_000;
            await page.waitForFunction(js, null, { timeout: timeoutMs });
            sendJson(response, 200, { ok: true });
            return;
          }
          case "/wait-load": {
            const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 30_000;
            await page.waitForLoadState("networkidle", { timeout: timeoutMs });
            sendJson(response, 200, { ok: true, state: "networkidle" });
            return;
          }
          case "/close": {
            sendJson(response, 200, { ok: true });
            setImmediate(() => void shutdown(0));
            return;
          }
          default:
            sendJson(response, 404, { error: `no such driver verb: ${url.pathname}` });
        }
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
      }
    })();
  });

  let shuttingDown = false;
  async function shutdown(code: number): Promise<never> {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    try {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } finally {
      process.exit(code);
    }
  }
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") fail("could not bind the driver server");
  process.stdout.write(`${JSON.stringify({ ok: true, url: `http://127.0.0.1:${address.port}` })}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
