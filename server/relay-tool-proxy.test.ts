import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "relay-tool-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
const servers: Server[] = [];

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function start(env: Record<string, string>) {
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return readline.createInterface({ input: child.stdout });
}

function nextJson(lines: readline.Interface) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
}

function toolCall(id: number) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "arxiv_search", arguments: {} } })}\n`;
}

/** A harness that hands out a distinct assertion per sign request, recording
 * the bearer it saw. */
async function signingHarness(seen: string[]) {
  let issued = 0;
  return listen((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      seen.push(String(request.headers.authorization ?? ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ assertion: `assertion-${++issued}` }));
    });
  });
}

/** A Tool Layer that records the assertion presented on each call. */
async function recordingTools(calls: string[]) {
  return listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push(String(request.headers["x-relay-actor-user"] ?? ""));
      const message = JSON.parse(body) as { id: unknown };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } }));
    });
  });
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Relay tool proxy", () => {
  it("re-signs a fresh assertion for every forwarded call", async () => {
    const bearers: string[] = [];
    const presented: string[] = [];
    const harness = await signingHarness(bearers);
    const tools = await recordingTools(presented);
    const lines = start({
      RELAY_HARNESS_URL: harness,
      RELAY_TOOL_URL: tools,
      RELAY_TOOL_TOKEN: "cap-1",
      RELAY_AGENT: "scout",
    });

    child!.stdin.write(toolCall(1));
    expect((await nextJson(lines)).id).toBe(1);
    child!.stdin.write(toolCall(2));
    expect((await nextJson(lines)).id).toBe(2);

    expect(bearers).toEqual(["Bearer cap-1", "Bearer cap-1"]);
    expect(presented).toEqual(["assertion-1", "assertion-2"]);
  });

  it("does not share one assertion between concurrent calls", async () => {
    const present: string[] = [];
    const harness = await signingHarness([]);
    const tools = await recordingTools(present);
    const lines = start({
      RELAY_HARNESS_URL: harness,
      RELAY_TOOL_URL: tools,
      RELAY_TOOL_TOKEN: "cap-1",
      RELAY_AGENT: "scout",
    });

    child!.stdin.write(`${toolCall(1)}${toolCall(2)}`);
    const replies = [await nextJson(lines), await nextJson(lines)];
    expect(replies.map((reply) => reply.id).sort()).toEqual([1, 2]);
    expect([...present].sort()).toEqual(["assertion-1", "assertion-2"]);
  });

  it("fails a tool call closed when the harness refuses to sign", async () => {
    const harness = await listen((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{}");
    });
    const tools = await recordingTools([]);
    const lines = start({
      RELAY_HARNESS_URL: harness,
      RELAY_TOOL_URL: tools,
      RELAY_TOOL_TOKEN: "cap-1",
      RELAY_AGENT: "scout",
    });

    child!.stdin.write(toolCall(9));
    const reply = (await nextJson(lines)) as { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(reply.id).toBe(9);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/could not authorize/i);
  });

  it("fails a tool call closed when it has no capability token", async () => {
    const harness = await signingHarness([]);
    const tools = await recordingTools([]);
    // No token means no call can be signed; it must surface as an error, never
    // a silent success, and must never reach the Tool Layer.
    const lines = start({ RELAY_HARNESS_URL: harness, RELAY_TOOL_URL: tools, RELAY_TOOL_TOKEN: "", RELAY_AGENT: "scout" });
    child!.stdin.write(toolCall(3));
    const reply = (await nextJson(lines)) as { result: { isError?: boolean } };
    expect(reply.result.isError).toBe(true);
  });
});
