import { createHmac, timingSafeEqual } from "node:crypto";

import type { RelayAgentRole } from "../packages/relay-shared/relay-agent.ts";
import type { McpServerSpec, RemoteMcpSpec, StdioMcpSpec } from "./contracts.ts";

export type RelayAgent = RelayAgentRole;

const AGENTS = new Set<RelayAgent>(["scout", "mercury", "curator"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const ASSERTION_KEYS = "agent,botId,issuedAt,signature,threadId,userId";
/** Assertions older than this are rejected. Must match services/tool-layer. */
const ASSERTION_MAX_SKEW_SECONDS = 5 * 60;

/** Env marker on the stdio proxy that fronts the Tool Layer. It lets the
 * drivers recognize the harness-owned Relay route — and pre-allow its tools —
 * without trusting a name or a URL alone. */
export const RELAY_TOOL_PROXY_MARKER = "RELAY_RELAY_TOOL_PROXY";

/** Fixed HMAC input prefix. Must match services/tool-layer and services/bff. */
const ACTOR_ASSERTION_PURPOSE = "relay-actor";

/** Sign the owner's actor context for the Tool Layer. Email is deliberately
 * absent: the owner key is the Supabase UUID, and the sign-in domain allow-list
 * is enforced where the session is issued, not here. The agent role travels
 * signed so the Tool Layer and BFF can both bind a call to its route. */
export function signedActorContext(
  actor: { userId: string; botId: string; threadId: string; agent: RelayAgent },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const userId = actor.userId.trim().toLowerCase();
  const botId = actor.botId.trim().toLowerCase();
  const threadId = actor.threadId.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay MCP actor user id must be a UUID");
  if (!UUID.test(botId)) throw new Error("Relay MCP actor bot id must be a UUID");
  if (!UUID.test(threadId)) throw new Error("Relay MCP actor thread id must be a UUID");
  if (!AGENTS.has(actor.agent)) throw new Error("Relay MCP actor agent must be a known role");
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify([ACTOR_ASSERTION_PURPOSE, userId, issuedAt, botId, threadId, actor.agent]))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId, threadId, agent: actor.agent, signature });
}

/** Verify an actor assertion the harness (or BFF) signed. Same scheme the
 * Tool Layer and BFF enforce: exact key set, UUID identities, 5-minute skew,
 * HMAC over [purpose, userId, issuedAt, botId, threadId, agent]. New code, no new
 * secret — verification uses the same RELAY_TOOL_ACTOR_SECRET the harness
 * already signs with. */
export function verifyActorAssertion(
  value: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): { userId: string; botId: string; threadId: string; agent: RelayAgent } {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("actor assertion secret is not configured");
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new Error("actor assertion is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("actor assertion is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("actor assertion is invalid");
  }
  const assertion = parsed as Record<string, unknown>;
  if (Object.keys(assertion).sort().join(",") !== ASSERTION_KEYS ||
      typeof assertion.userId !== "string" || !UUID.test(assertion.userId) ||
      typeof assertion.botId !== "string" || !UUID.test(assertion.botId) ||
      typeof assertion.threadId !== "string" || !UUID.test(assertion.threadId) ||
      typeof assertion.agent !== "string" || !AGENTS.has(assertion.agent as RelayAgent) ||
      typeof assertion.issuedAt !== "number" || !Number.isSafeInteger(assertion.issuedAt) ||
      typeof assertion.signature !== "string" || !SIGNATURE.test(assertion.signature)) {
    throw new Error("actor assertion is invalid");
  }
  if (Math.abs(Math.floor(now / 1000) - assertion.issuedAt) > ASSERTION_MAX_SKEW_SECONDS) {
    throw new Error("actor assertion is expired or outside allowed clock skew");
  }
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify([ACTOR_ASSERTION_PURPOSE, assertion.userId, assertion.issuedAt, assertion.botId, assertion.threadId, assertion.agent]))
    .digest();
  const received = Buffer.from(assertion.signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("actor assertion signature is invalid");
  }
  return { userId: assertion.userId, botId: assertion.botId, threadId: assertion.threadId, agent: assertion.agent as RelayAgent };
}

/** Validate RELAY_TOOL_URL as a bare http(s) origin and return it, so both the
 * proxy spec and the startup smoke check agree on what a valid Tool Layer
 * address is. */
function relayToolOrigin(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("RELAY_TOOL_URL must be an http origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    throw new Error("RELAY_TOOL_URL must be an http(s) origin with no path, credentials, query, or hash");
  }
  return url.origin;
}

/** The private Tool Layer transport; users do not configure Relay MCP servers
 * in the Plugins UI. Kept as the URL validator and for compose-network smoke
 * checks — the actor's own calls ride the signed stdio proxy below. */
export function relayToolMcpServer(agent: RelayAgent, baseUrl: string): RemoteMcpSpec {
  return { type: "http", url: `${relayToolOrigin(baseUrl)}/mcp/${agent}`, headers: {} };
}

/** Construct the harness-owned stdio proxy for the Tool Layer route. The
 * engine holds only a turn-scoped capability token, never the actor secret:
 * the proxy asks the harness to sign one short-lived assertion per forwarded
 * call, so a turn that runs past the assertion window never presents a stale
 * one. Authentication is that per-call HMAC assertion, never the URL. */
export function relayToolProxySpec(input: {
  agent: RelayAgent;
  toolUrl: string;
  harnessUrl: string;
  token: string;
  proxyPath: string;
}): StdioMcpSpec {
  const origin = relayToolOrigin(input.toolUrl);
  return {
    command: process.execPath,
    args: [input.proxyPath],
    env: {
      // In the packaged app process.execPath is Electron — run the proxy as node.
      ELECTRON_RUN_AS_NODE: "1",
      [RELAY_TOOL_PROXY_MARKER]: "1",
      RELAY_HARNESS_URL: input.harnessUrl,
      RELAY_TOOL_URL: origin,
      RELAY_TOOL_TOKEN: input.token,
      RELAY_AGENT: input.agent,
    },
  };
}

function relayRoute(urlText: string): RelayAgent | "invalid" | null {
  let url: URL;
  try { url = new URL(urlText); } catch { return null; }
  if (!url.pathname.startsWith("/mcp/")) return null;
  const route = url.pathname.slice("/mcp/".length);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || url.search || url.hash || !AGENTS.has(route as RelayAgent)) {
    return "invalid";
  }
  return route as RelayAgent;
}

/** The owner a Relay call may be signed for: the bot's own owner, and only when
 * the thread really belongs to that owner — the bot's own chat or task, or a
 * room this account owns. A thread resolving to another owner (or none) is
 * never signed, so neither the harness nor the proxy can act across owners. */
export function relaySigningOwner(
  bot: { ownerUserId?: string },
  threadOwnerUserId: string | undefined,
): string | undefined {
  return bot.ownerUserId && threadOwnerUserId === bot.ownerUserId ? bot.ownerUserId : undefined;
}

/** A server is the Relay route either because it is the signed stdio proxy the
 * harness built, or — defensively — a configured entry that names a Relay
 * route. Only the first is mounted; the second is dropped. */
export function isRelayMcpServer(name: string, server: McpServerSpec): boolean {
  if ("url" in server) {
    const route = relayRoute(server.url);
    return route !== null && route !== "invalid" && name === `relay-${route}` && server.type !== "sse";
  }
  const agent = server.env?.RELAY_AGENT;
  return server.env?.[RELAY_TOOL_PROXY_MARKER] === "1" &&
    typeof agent === "string" && AGENTS.has(agent as RelayAgent) && name === `relay-${agent}`;
}

/** Mount the harness-owned Relay route (the signed stdio proxy) in the bot's
 * own role. The role comes from the bot's own relayAgent tag, so every
 * account's Scout binds relay-scout. A configured entry that masquerades as a
 * Relay route is refused; other custom MCP servers pass through unchanged. */
export function bindRelayMcpForBot(
  role: RelayAgent | undefined,
  configured: Record<string, McpServerSpec>,
  relaySpec?: McpServerSpec,
): Record<string, McpServerSpec> {
  const result: Record<string, McpServerSpec> = {};
  const serversForBot = role && relaySpec && isRelayMcpServer(`relay-${role}`, relaySpec)
    ? { ...configured, [`relay-${role}`]: relaySpec }
    : configured;
  for (const [name, server] of Object.entries(serversForBot)) {
    if ("url" in server && relayRoute(server.url) !== null) continue;
    result[name] = server;
  }
  return result;
}
