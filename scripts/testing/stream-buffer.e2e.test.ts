import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { launchVerificationServer, runControlOmb } from "../control-relay.ts";
import { driverCall, ensureUiChrome, resolveUiChrome, startUiDriver } from "./control-relay-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.RELAY_UI_E2E === "1" || Boolean(resolveUiChrome(process.env));
if (!enabled) console.info("skipping stream-buffer e2e: no system Chrome resolves; set RELAY_UI_E2E=1 to require it");

it.skipIf(!enabled)("drains pending text and reasoning with rAF paused, then settles without duplicated output", async () => {
  const chrome = ensureUiChrome(process.env);
  const fixture = await launchVerificationServer(process.env);
  const driver = await startUiDriver({ chrome, home: fixture.info.dataDir });
  const browser = async (...args: string[]) => {
    const [verb, ...rest] = args;
    if (verb === "open") return driverCall(driver.url, "open", { url: rest[0]! });
    if (verb === "wait" && rest[0] === "--fn") return driverCall(driver.url, "wait-fn", { js: rest[1]! });
    if (verb === "wait") return driverCall(driver.url, "wait-load", {});
    if (verb === "eval") return driverCall(driver.url, "eval", { js: rest[0]! });
    if (verb === "console") return driverCall(driver.url, "console", {});
    throw new Error(`unsupported browser verb: ${verb}`);
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let preview: MountedPreview | undefined;
  let target: string[] | undefined;
  let read: (() => Promise<any>) | undefined;
  try {
    const wrapper = join(fixture.info.dataDir, "gated-stream.mjs");
    const gate = join(fixture.info.dataDir, "settle.gate");
    // The existing fake CLI emits both delta channels. Hold only its final
    // frames until the browser has observed the intermediate renderer state.
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      "import { existsSync } from 'node:fs';",
      "if (process.argv.includes('--input-format')) {",
      "process.env.FAKE_CLAUDE_MODE = 'stream';",
      "process.env.FAKE_CLAUDE_TOOL_CALLS = '[]';",
      "const write = process.stdout.write.bind(process.stdout);",
      "const pending = []; let held = false;",
      "process.stdout.write = (chunk) => {",
      "const frame = JSON.parse(String(chunk));",
      "if (held || frame.type === 'assistant') { held = true; pending.push(chunk); return true; }",
      "return write(chunk); };",
      `const timer = setInterval(() => { if (!existsSync(${JSON.stringify(gate)})) return;`,
      "clearInterval(timer); process.stdout.write = write; for (const chunk of pending) write(chunk); }, 10);",
      "}",
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const created = await control("new-bot", "--name", "Stream fixture");
    target = ["--bot", created.bot.id, "--task", created.bot.activeTaskId];
    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/stream-buffer-preview.tsx", route: "/__stream-buffer.html",
      title: "Isolated stream buffer", logLevel: "warn",
    });
    await browser("open", preview.previewUrl);
    await browser("wait", "--fn", "document.querySelector('#ready')?.textContent === 'true'");
    const before = await browser("eval", "JSON.parse(document.querySelector('#messages').textContent)");
    const finalMessages = [...before.result, "hello from fake claude"];
    await browser("eval", "window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {};");
    await control("send", ...target, "--text", "Show the whole reply");
    await browser("wait", "--fn", "document.querySelector('#text').textContent === 'hello from fake claude' && document.querySelector('#reasoning').textContent === 'hmm'");
    read = () => browser("eval", "({text: document.querySelector('#text').textContent, reasoning: document.querySelector('#reasoning').textContent, messages: JSON.parse(document.querySelector('#messages').textContent), digests: JSON.parse(document.querySelector('#digests').textContent)})");
    const intermediate = await read();
    evidence.push({ intermediate });
    expect(intermediate.result).toEqual({ text: "hello from fake claude", reasoning: "hmm", messages: before.result, digests: [] });
    writeFileSync(gate, "settle");
    const settled = await control("wait", ...target, "--timeout", "15");
    expect(settled.status).toBe("settled");
    const messages = await control("messages", ...target, "--limit", "10") as { messages: WireMessage[] };
    evidence.push({ settled, messages });
    // Audit receipts remain in the store and transcript, separate from replies.
    const digests = messages.messages.filter(message => message.kind === "digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ role: "bot", text: expect.stringContaining("hello from fake claude") });
    const digestIds = digests.map(message => message.id);
    expect(messages.messages.filter(message => message.role === "bot" && message.kind === "text").map(message => message.text)).toEqual(finalMessages);
    await browser("wait", "--fn", `document.querySelector('#messages').textContent === ${JSON.stringify(JSON.stringify(finalMessages))} && document.querySelector('#digests').textContent === ${JSON.stringify(JSON.stringify(digestIds))} && document.querySelector('#text').textContent === '' && document.querySelector('#reasoning').textContent === ''`);
    // Wait past the fallback timer: no cleared delta may reappear afterward.
    await browser("eval", "new Promise(resolve => setTimeout(resolve, 250))");
    const final = await read();
    evidence.push({ final });
    expect(final.result).toEqual({ text: "", reasoning: "", messages: finalMessages, digests: digestIds });
    const logs = await browser("console");
    expect(logs.messages.filter((message: { type: string }) => message.type === "error")).toEqual([]);
  } finally {
    let browserClosed = false;
    try {
      // Capture the last observable state even when an assertion or wait fails.
      evidence.push({
        atTeardown: await read?.().catch(error => ({ error: String(error) })),
        messages: target && await control("messages", ...target, "--limit", "10").catch(error => ({ error: String(error) })),
      });
    } finally {
      try { await driver.stop(); browserClosed = true; } catch { browserClosed = false; }
      finally {
        try { await preview?.close(); }
        finally {
          try { await fixture.close(); }
          finally {
            const dataRemoved = !existsSync(fixture.info.dataDir);
            evidence.push({ cleanup: { browserClosed, dataRemoved } });
            const evidencePath = `${fixture.info.logPath}.stream.json`;
            writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
            console.info(JSON.stringify({ evidencePath, serverPid: fixture.info.pid, dataRemoved }));
          }
        }
      }
    }
    expect(browserClosed).toBe(true);
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 120_000);
