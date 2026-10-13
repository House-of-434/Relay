import { createHmac } from "node:crypto";

import type { RelayAgentRole } from "../packages/relay-shared/relay-agent.ts";
import type { McpServerSpec, RemoteMcpSpec } from "./contracts.ts";

export type RelayAgent = RelayAgentRole;

const AGENTS = new Set<RelayAgent>(["scout", "mercury", "curator"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fixed HMAC input prefix. Must match services/tool-layer and services/bff. */
const ACTOR_ASSERTION_PURPOSE = "relay-actor";

/** Sign the owner's actor context for the Tool Layer. Email is deliberately
 * absent: the owner key is the Supabase UUID, and the sign-in domain allow-list
 * is enforced where the session is issued, not here. */
export function signedActorContext(
  actor: { userId: string; botId: string; threadId: string },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const userId = actor.userId.trim().toLowerCase();
  const botId = actor.botId.trim().toLowerCase();
  const threadId = actor.threadId.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay MCP actor user id must be a UUID");
  if (!UUID.test(botId)) throw new Error("Relay MCP actor bot id must be a UUID");
  if (!UUID.test(threadId)) throw new Error("Relay MCP actor thread id must be a UUID");
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify([ACTOR_ASSERTION_PURPOSE, userId, issuedAt, botId, threadId]))
    .digest("base64url");
  return JSON.stringify({ userId, issuedAt, botId, threadId, signature });
}

/** Construct the private Tool Layer route; users do not configure Relay MCP
 * servers in the Plugins UI. The harness connects either to a loopback
 * child process or to the compose-network Tool Layer service; authentication
 * is the HMAC actor assertion, never the URL. */
export function relayToolMcpServer(agent: RelayAgent, baseUrl: string): RemoteMcpSpec {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("RELAY_TOOL_URL must be an http origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    throw new Error("RELAY_TOOL_URL must be an http(s) origin with no path, credentials, query, or hash");
  }
  return { type: "http", url: `${url.origin}/mcp/${agent}`, headers: {} };
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

export function isRelayMcpServer(name: string, server: McpServerSpec): boolean {
  if (!("url" in server)) return false;
  const route = relayRoute(server.url);
  return route !== null && route !== "invalid" && name === `relay-${route}` && server.type !== "sse";
}

/** Keep the Relay endpoints in the harness-owned bot role, and attach the
 * bot's owner identity outside the model's tool arguments. The role comes from
 * the bot's own relayAgent tag, so every account's Scout binds /mcp/scout.
 * Other custom MCP servers pass through unchanged. */
export function bindRelayMcpForBot(
  botId: string,
  role: RelayAgent | undefined,
  ownerUserId: string | undefined,
  threadId: string | undefined,
  configured: Record<string, McpServerSpec>,
  toolUrl?: string,
): Record<string, McpServerSpec> {
  const result: Record<string, McpServerSpec> = {};
  const serversForBot = role && toolUrl
    ? { ...configured, [`relay-${role}`]: relayToolMcpServer(role, toolUrl) }
    : configured;
  for (const [name, server] of Object.entries(serversForBot)) {
    if (!("url" in server)) {
      result[name] = server;
      continue;
    }
    const route = relayRoute(server.url);
    if (!route) {
      result[name] = server;
      continue;
    }
    if (route === "invalid" || role !== route || !isRelayMcpServer(name, server)) continue;

    const headers = Object.fromEntries(
      Object.entries(server.headers).filter(([key]) =>
        key.toLowerCase() !== "x-relay-actor-user" && key.toLowerCase() !== "authorization"),
    );
    if (ownerUserId && threadId) {
      headers["x-relay-actor-user"] = signedActorContext(
        { userId: ownerUserId, botId, threadId },
        process.env.RELAY_TOOL_ACTOR_SECRET,
      );
    }
    result[name] = { ...server, headers } as RemoteMcpSpec;
  }

  return result;
}
