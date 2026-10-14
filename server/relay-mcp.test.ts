import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindRelayMcpForBot, relayToolMcpServer } from "./relay-mcp.ts";

const BOT_SCOUT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THREAD_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const servers = {
  "relay-scout": {
    type: "http" as const,
    url: "http://127.0.0.1:8787/mcp/scout",
    headers: { Authorization: "Bearer stale", "x-relay-actor-user": "spoofed unsigned actor" },
  },
  "relay-mercury": {
    type: "http" as const,
    url: "http://127.0.0.1:8787/mcp/mercury",
    headers: {},
  },
  notes: { type: "http" as const, url: "https://notes.example.test/mcp", headers: {} },
};
const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";
const USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";

afterEach(() => vi.unstubAllEnvs());

describe("Relay MCP bot binding", () => {
  it("binds only the bot's own role route and signs the owner UUID plus bot and thread", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    const mounted = bindRelayMcpForBot(BOT_SCOUT, "scout", USER_ID, THREAD_ID, servers);
    expect(Object.keys(mounted).sort()).toEqual(["notes", "relay-scout"]);
    const relay = mounted["relay-scout"] as { url: string; headers: Record<string, string> };
    expect(relay).toMatchObject({
      url: "http://127.0.0.1:8787/mcp/scout",
    });
    const assertion = JSON.parse(relay.headers["x-relay-actor-user"]!) as {
      userId: string; botId: string; threadId: string; agent: string; issuedAt: number; signature: string;
    };
    expect(assertion).toMatchObject({ userId: USER_ID, botId: BOT_SCOUT, threadId: THREAD_ID, agent: "scout" });
    expect(assertion.issuedAt).toEqual(expect.any(Number));
    expect(assertion.signature).toBe(createHmac("sha256", SECRET)
      .update(JSON.stringify(["relay-actor", USER_ID, assertion.issuedAt, BOT_SCOUT, THREAD_ID, "scout"]))
      .digest("base64url"));
    expect(relay.headers).not.toHaveProperty("Authorization");
    expect(mounted.notes).toEqual(servers.notes);
    vi.unstubAllEnvs();
  });

  it("does not mount another role's route, a renamed route, or a forged loopback path", () => {
    // A scout bot never mounts the mercury route, even if configured.
    expect(bindRelayMcpForBot(BOT_SCOUT, "scout", USER_ID, THREAD_ID, { "relay-mercury": servers["relay-mercury"] }))
      .toEqual({});
    expect(bindRelayMcpForBot(BOT_SCOUT, "curator", USER_ID, THREAD_ID, {
      notes: { type: "http", url: "http://127.0.0.1:8787/mcp/curator", headers: {} },
    })).toEqual({});
    // A bot with no Relay role mounts no Relay route.
    expect(bindRelayMcpForBot("bot-other", undefined, USER_ID, THREAD_ID, { "relay-scout": servers["relay-scout"] }))
      .toEqual({});
  });

  it("auto-mounts only the matching built-in role route and injects the owner actor", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    const scout = bindRelayMcpForBot(BOT_SCOUT, "scout", USER_ID, THREAD_ID, {}, "http://127.0.0.1:8787");
    expect(Object.keys(scout)).toEqual(["relay-scout"]);
    expect(JSON.parse((scout["relay-scout"] as any).headers["x-relay-actor-user"])).toMatchObject({
      userId: USER_ID, botId: BOT_SCOUT, threadId: THREAD_ID,
    });
    expect(bindRelayMcpForBot(BOT_SCOUT, "mercury", USER_ID, THREAD_ID, {}, "http://127.0.0.1:8787"))
      .toHaveProperty("relay-mercury");
    // An ownerless bot is never signed.
    expect(bindRelayMcpForBot(BOT_SCOUT, "scout", undefined, THREAD_ID, {}, "http://127.0.0.1:8787")["relay-scout"])
      .toMatchObject({ headers: {} });
    vi.unstubAllEnvs();
  });

  it("requires UUID owner, bot, and thread identity", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    expect(() => bindRelayMcpForBot(BOT_SCOUT, "scout", "ada@houseof434.com", THREAD_ID, {}, "http://127.0.0.1:8787"))
      .toThrow(/UUID/);
    expect(() => bindRelayMcpForBot("bot-scout", "scout", USER_ID, THREAD_ID, {}, "http://127.0.0.1:8787"))
      .toThrow(/UUID/);
    expect(() => bindRelayMcpForBot(BOT_SCOUT, "scout", USER_ID, "not-a-uuid", {}, "http://127.0.0.1:8787"))
      .toThrow(/UUID/);
    vi.unstubAllEnvs();
  });

  it("requires the separate service actor secret before attaching owner identity", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", "");
    expect(() => bindRelayMcpForBot(BOT_SCOUT, "scout", USER_ID, THREAD_ID, {}, "http://127.0.0.1:8787"))
      .toThrow(/RELAY_TOOL_ACTOR_SECRET/);
  });

  it("accepts compose-network Relay Tool Layer URLs and refuses malformed origins", () => {
    expect(relayToolMcpServer("scout", "http://tools:8787")).toEqual({
      type: "http", url: "http://tools:8787/mcp/scout", headers: {},
    });
    for (const url of ["https://user:pw@tools.example.com", "http://tools/mcp/scout?x=1", "ftp://tools:8787"]) {
      expect(() => relayToolMcpServer("scout", url)).toThrow("RELAY_TOOL_URL must be an http(s) origin");
    }
  });
});
