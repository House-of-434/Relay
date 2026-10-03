import { createHmac } from "node:crypto";

import type { RelayAgentRole } from "../packages/relay-shared/relay-agent.ts";
import type { McpServerSpec, RemoteMcpSpec } from "./contracts.ts";

export type RelayAgent = RelayAgentRole;
export type RelayAgentBotIds = Readonly<Record<RelayAgent, string | undefined>>;

const AGENTS = new Set<RelayAgent>(["scout", "mercury", "curator"]);
const AGENT_ID_ENV: Record<RelayAgent, string> = {
  scout: "RELAY_SCOUT_BOT_ID",
  mercury: "RELAY_MERCURY_BOT_ID",
  curator: "RELAY_CURATOR_BOT_ID",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function signedActorContext(
  actor: { userId: string; email: string },
  secret: string | undefined,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const userId = actor.userId.trim().toLowerCase();
  const email = actor.email.trim().toLowerCase();
  if (!UUID.test(userId)) throw new Error("Relay MCP actor user id must be a UUID");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Relay MCP actor email metadata is invalid");
  }
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify([userId, email, issuedAt]))
    .digest("base64url");
  return JSON.stringify({ userId, email, issuedAt, signature });
}

export function relayAgentBotIds(
  bots: readonly { id: string; relayAgent?: RelayAgent }[],
  env: NodeJS.ProcessEnv = process.env,
): RelayAgentBotIds {
  const result = {} as Record<RelayAgent, string | undefined>;
  for (const role of AGENTS) {
    const tagged = bots.filter((bot) => bot.relayAgent === role);
    if (tagged.length > 1) throw new Error(`Only one default Relay ${role} agent may be registered`);
    const configured = env[AGENT_ID_ENV[role]]?.trim();
    if (configured && tagged[0] && configured !== tagged[0].id) {
      throw new Error(`${AGENT_ID_ENV[role]} conflicts with the role assigned to bot ${tagged[0].id}`);
    }
    result[role] = configured || tagged[0]?.id;
  }
  const ids = Object.values(result).filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) throw new Error("Relay agent bot IDs must be unique");
  return result;
}

/** Construct the private Tool Layer route; users do not configure Relay MCP
 * servers in the Plugins UI. The server itself remains loopback-only. */
export function relayToolMcpServer(agent: RelayAgent, baseUrl: string): RemoteMcpSpec {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("RELAY_TOOL_URL must be a loopback HTTP origin on port 8787"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopback || url.port !== "8787" ||
      (url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    throw new Error("RELAY_TOOL_URL must be a loopback HTTP origin on port 8787");
  }
  return { type: "http", url: `${url.origin}/mcp/${agent}`, headers: {} };
}

function relayRoute(urlText: string): RelayAgent | "invalid" | null {
  let url: URL;
  try { url = new URL(urlText); } catch { return null; }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback || url.port !== "8787" || !url.pathname.startsWith("/mcp/")) return null;
  const route = url.pathname.slice("/mcp/".length);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !AGENTS.has(route as RelayAgent)) {
    return "invalid";
  }
  return route as RelayAgent;
}

export function isRelayMcpServer(name: string, server: McpServerSpec): boolean {
  if (!("url" in server)) return false;
  const route = relayRoute(server.url);
  return route !== null && route !== "invalid" && name === `relay-${route}` && server.type !== "sse";
}

/** Keep the Relay endpoints in the harness-owned bot role, and attach session
 * identity outside the model's tool arguments. Other custom MCP servers pass
 * through unchanged. */
export function bindRelayMcpForBot(
  botId: string,
  actor: { userId?: string; email?: string } | undefined,
  configured: Record<string, McpServerSpec>,
  agentBotIds: RelayAgentBotIds,
  toolUrl?: string,
): Record<string, McpServerSpec> {
  const matchingRoles = (Object.entries(agentBotIds) as Array<[RelayAgent, string | undefined]>)
    .filter(([, configuredId]) => configuredId && configuredId === botId)
    .map(([agent]) => agent);
  if (matchingRoles.length > 1) throw new Error("Relay agent bot IDs must be unique");
  const botRole = matchingRoles[0];
  const result: Record<string, McpServerSpec> = {};

  const serversForBot = botRole && toolUrl
    ? { ...configured, [`relay-${botRole}`]: relayToolMcpServer(botRole, toolUrl) }
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
    if (route === "invalid" || botRole !== route || !isRelayMcpServer(name, server)) continue;

    const headers = Object.fromEntries(
      Object.entries(server.headers).filter(([key]) =>
        key.toLowerCase() !== "x-relay-actor-user" && key.toLowerCase() !== "authorization"),
    );
    if (actor?.userId && actor.email) {
      headers["x-relay-actor-user"] = signedActorContext(actor as { userId: string; email: string }, process.env.RELAY_TOOL_ACTOR_SECRET);
    }
    result[name] = { ...server, headers } as RemoteMcpSpec;
  }

  return result;
}
