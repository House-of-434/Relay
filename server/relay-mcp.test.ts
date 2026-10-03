import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindRelayMcpForBot, relayAgentBotIds, relayToolMcpServer } from "./relay-mcp.ts";

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
  const botIds = { scout: "bot-scout", mercury: "bot-mercury", curator: "bot-curator" } as const;

  it("binds only the matching agent route and signs verified session UUID plus email metadata", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    const mounted = bindRelayMcpForBot("bot-scout", { userId: USER_ID, email: "Alice@HouseOf434.com" }, servers, botIds);
    expect(Object.keys(mounted).sort()).toEqual(["notes", "relay-scout"]);
    const relay = mounted["relay-scout"] as { url: string; headers: Record<string, string> };
    expect(relay).toMatchObject({
      url: "http://127.0.0.1:8787/mcp/scout",
    });
    const assertion = JSON.parse(relay.headers["x-relay-actor-user"]!) as {
      userId: string; email: string; issuedAt: number; signature: string;
    };
    expect(assertion).toMatchObject({ userId: USER_ID, email: "alice@houseof434.com" });
    expect(assertion.issuedAt).toEqual(expect.any(Number));
    expect(assertion.signature).toBe(createHmac("sha256", SECRET)
      .update(JSON.stringify([USER_ID, assertion.email, assertion.issuedAt]))
      .digest("base64url"));
    expect(relay.headers).not.toHaveProperty("Authorization");
    expect(mounted.notes).toEqual(servers.notes);
    vi.unstubAllEnvs();
  });

  it("does not mount another agent's route, a renamed route, or a forged loopback path", () => {
    expect(bindRelayMcpForBot("bot-scout", undefined, { "relay-mercury": servers["relay-mercury"] }, botIds))
      .toEqual({});
    expect(bindRelayMcpForBot("bot-scout", undefined, {
      notes: { type: "http", url: "http://127.0.0.1:8787/mcp/curator", headers: {} },
    }, botIds)).toEqual({});
    expect(bindRelayMcpForBot("bot-other", undefined, { "relay-scout": servers["relay-scout"] }, botIds))
      .toEqual({});
  });

  it("resolves role IDs from seeded metadata, while preserving explicit legacy overrides", () => {
    expect(relayAgentBotIds([
      { id: "s", relayAgent: "scout" },
      { id: "m", relayAgent: "mercury" },
      { id: "c", relayAgent: "curator" },
    ], {})).toEqual({ scout: "s", mercury: "m", curator: "c" });
    expect(relayAgentBotIds([{ id: "s", relayAgent: "scout" }], { RELAY_MERCURY_BOT_ID: "legacy-m" }))
      .toEqual({ scout: "s", mercury: "legacy-m", curator: undefined });
    expect(() => relayAgentBotIds([
      { id: "s", relayAgent: "scout" },
      { id: "s-2", relayAgent: "scout" },
    ], {})).toThrow("Only one default Relay scout agent");
  });

  it("auto-mounts only the matching built-in role route and injects the current actor", () => {
    const ids = { scout: "s", mercury: "m", curator: "c" } as const;
    expect(relayToolMcpServer("scout", "http://127.0.0.1:8787")).toEqual({
      type: "http", url: "http://127.0.0.1:8787/mcp/scout", headers: {},
    });
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    const scout = bindRelayMcpForBot("s", { userId: USER_ID, email: "ada@houseof434.com" }, {}, ids, "http://127.0.0.1:8787");
    expect(Object.keys(scout)).toEqual(["relay-scout"]);
    expect(JSON.parse((scout["relay-scout"] as any).headers["x-relay-actor-user"])).toMatchObject({
      userId: USER_ID, email: "ada@houseof434.com",
    });
    expect(bindRelayMcpForBot("m", { userId: USER_ID, email: "ada@houseof434.com" }, {}, ids, "http://127.0.0.1:8787"))
      .toHaveProperty("relay-mercury");
    expect(bindRelayMcpForBot("s", { email: "ada@houseof434.com" }, {}, ids, "http://127.0.0.1:8787")["relay-scout"])
      .toMatchObject({ headers: {} });
    vi.unstubAllEnvs();
  });

  it("requires UUID actor identity rather than treating email metadata as identity", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", SECRET);
    expect(() => bindRelayMcpForBot("s", { userId: "ada@houseof434.com", email: "ada@houseof434.com" }, {}, {
      scout: "s", mercury: "m", curator: "c",
    }, "http://127.0.0.1:8787")).toThrow(/UUID/);
    vi.unstubAllEnvs();
  });

  it("requires the separate service actor secret before attaching session identity", () => {
    vi.stubEnv("RELAY_TOOL_ACTOR_SECRET", "");
    expect(() => bindRelayMcpForBot("s", { userId: USER_ID, email: "ada@houseof434.com" }, {}, {
      scout: "s", mercury: "m", curator: "c",
    }, "http://127.0.0.1:8787")).toThrow(/RELAY_TOOL_ACTOR_SECRET/);
  });

  it("refuses non-loopback Relay Tool Layer URLs", () => {
    for (const url of ["https://tools.example.com", "http://10.0.0.3:8787", "http://127.0.0.1:9999"]) {
      expect(() => relayToolMcpServer("scout", url)).toThrow("loopback HTTP origin on port 8787");
    }
  });
});
