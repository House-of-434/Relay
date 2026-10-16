// Harness-owned stdio bridge to the Relay Tool Layer.
//
// The provider CLI mounts this instead of reaching the Tool Layer directly.
// The harness never hands the actor secret to the engine; this proxy holds a
// turn-scoped capability token and, for every forwarded call, asks the harness
// to sign one short-lived actor assertion. That is what keeps a long turn from
// presenting an assertion older than the Tool Layer's skew window — the bug
// this replaces (a header signed once per bind and then fixed for the process).
//
// All state comes from env, injected by the harness:
//   RELAY_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   RELAY_TOOL_URL     bare http(s) origin of the Tool Layer
//   RELAY_TOOL_TOKEN   turn-scoped capability the harness maps to this actor
//   RELAY_AGENT        scout | mercury | curator — the /mcp/<agent> route
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";

type Json = Record<string, unknown>;

const HARNESS = process.env.RELAY_HARNESS_URL ?? "http://127.0.0.1:8799";
const TOOL_URL = process.env.RELAY_TOOL_URL ?? "";
const TOKEN = process.env.RELAY_TOOL_TOKEN ?? "";
const AGENT = process.env.RELAY_AGENT ?? "";
const AGENTS = new Set(["scout", "mercury", "curator"]);
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 10 * 60_000;
const SIGN_TIMEOUT_MS = 30_000;

function fail(message: string): never {
  process.stderr.write(`relay-tool-proxy: ${message}\n`);
  process.exit(1);
}

function toolOrigin(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { fail("RELAY_TOOL_URL must be an http origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    fail("RELAY_TOOL_URL must be an http(s) origin with no path, credentials, query, or hash");
  }
  return url.origin;
}

if (!AGENTS.has(AGENT)) fail(`RELAY_AGENT must be one of ${[...AGENTS].join(", ")}`);

const UPSTREAM = `${toolOrigin(TOOL_URL)}/mcp/${AGENT}`;
let upstreamSessionId = "";

const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("the Relay tool result exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("the Relay tool result exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

/** Ask the harness for one fresh actor assertion. The harness derives the
 * actor from the capability, never from anything this process sends. */
async function sign(): Promise<string> {
  if (!TOKEN) throw new Error("the Relay tool bridge has no capability token");
  const response = await fetch(`${HARNESS}/api/internal/sign-actor`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the Relay tool bridge could not authorize this call (HTTP ${response.status})`);
  const body = (await response.json().catch(() => ({}))) as { assertion?: unknown };
  if (typeof body.assertion !== "string" || !body.assertion) throw new Error("the Relay tool bridge returned no assertion");
  return body.assertion;
}

function messageId(body: unknown): unknown {
  if (Array.isArray(body)) return (body[0] as Json | undefined)?.id;
  return (body as Json | undefined)?.id;
}

async function relay(body: unknown): Promise<Json | null> {
  const assertion = await sign();
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-relay-actor-user": assertion,
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`the Relay tool service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), messageId(body));
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  try {
    const response = await relay(message);
    if (response && id !== undefined && id !== null) send(response);
  } catch (error) {
    if (id === undefined || id === null) return;
    const text = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, text, true));
    else send(jsonRpcError(id, text));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const frame = parsed as Json;
  void handle(frame).catch((error) => {
    if (frame.id === undefined || frame.id === null) return;
    const text = error instanceof Error ? error.message : String(error);
    if (String(frame.method ?? "") === "tools/call") send(textResult(frame.id, text, true));
    else send(jsonRpcError(frame.id, text));
  });
});
input.on("close", () => process.exit(0));

// Handled (no-op) so an unhandled rejection during shutdown cannot mask the
// real exit path; a bridge that dies must fail closed, not silently.
process.on("unhandledRejection", (error) => fail(error instanceof Error ? error.message : String(error)));
