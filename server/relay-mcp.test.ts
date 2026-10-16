import { describe, expect, it } from "vitest";

import {
  RELAY_TOOL_PROXY_MARKER,
  bindRelayMcpForBot,
  isRelayMcpServer,
  relaySigningOwner,
  relayToolMcpServer,
  relayToolProxySpec,
} from "./relay-mcp.ts";

const PROXY_PATH = "/opt/relay/relay-tool-proxy.js";

const proxySpec = relayToolProxySpec({
  agent: "scout",
  toolUrl: "http://127.0.0.1:8787",
  harnessUrl: "http://127.0.0.1:8799",
  token: "capability-token",
  proxyPath: PROXY_PATH,
});

function proxySpecFor(agent: "scout" | "mercury" | "curator", token = "capability-token") {
  return relayToolProxySpec({
    agent,
    toolUrl: "http://127.0.0.1:8787",
    harnessUrl: "http://127.0.0.1:8799",
    token,
    proxyPath: PROXY_PATH,
  });
}

describe("Relay tool proxy spec", () => {
  it("builds a stdio proxy that carries a capability token, never the actor secret", () => {
    expect(proxySpec).toEqual({
      command: process.execPath,
      args: [PROXY_PATH],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        [RELAY_TOOL_PROXY_MARKER]: "1",
        RELAY_HARNESS_URL: "http://127.0.0.1:8799",
        RELAY_TOOL_URL: "http://127.0.0.1:8787",
        RELAY_TOOL_TOKEN: "capability-token",
        RELAY_AGENT: "scout",
      },
    });
    expect(JSON.stringify(proxySpec)).not.toContain("ACTOR_SECRET");
  });

  it("accepts a compose-network Tool Layer and refuses malformed origins", () => {
    expect(proxySpecFor("scout").env.RELAY_TOOL_URL).toBe("http://127.0.0.1:8787");
    expect(relayToolProxySpec({
      agent: "scout", toolUrl: "http://tools:8787", harnessUrl: "http://127.0.0.1:8799", token: "", proxyPath: PROXY_PATH,
    }).env.RELAY_TOOL_URL).toBe("http://tools:8787");
    for (const url of ["https://user:pw@tools.example.com", "http://tools/mcp/scout?x=1", "ftp://tools:8787"]) {
      expect(() => relayToolProxySpec({
        agent: "scout", toolUrl: url, harnessUrl: "http://127.0.0.1:8799", token: "", proxyPath: PROXY_PATH,
      })).toThrow("RELAY_TOOL_URL must be an http(s) origin");
    }
  });
});

describe("Relay MCP route recognition", () => {
  it("recognizes the harness proxy only under its own name and marker", () => {
    expect(isRelayMcpServer("relay-scout", proxySpec)).toBe(true);
    expect(isRelayMcpServer("relay-mercury", proxySpec)).toBe(false);
    expect(isRelayMcpServer("relay-scout", { command: process.execPath, args: [PROXY_PATH], env: {} })).toBe(false);
    // A configured stdio server cannot borrow the marker for another role.
    expect(isRelayMcpServer("relay-scout", {
      command: process.execPath, args: [PROXY_PATH], env: { [RELAY_TOOL_PROXY_MARKER]: "1", RELAY_AGENT: "mercury" },
    })).toBe(false);
  });

  it("still recognizes a URL-based Relay route and refuses malformed origins", () => {
    expect(isRelayMcpServer("relay-scout", { type: "http", url: "http://127.0.0.1:8787/mcp/scout", headers: {} })).toBe(true);
    expect(isRelayMcpServer("relay-scout", { type: "sse", url: "http://127.0.0.1:8787/mcp/scout", headers: {} })).toBe(false);
    expect(relayToolMcpServer("scout", "http://tools:8787")).toEqual({
      type: "http", url: "http://tools:8787/mcp/scout", headers: {},
    });
    for (const url of ["https://user:pw@tools.example.com", "http://tools/mcp/scout?x=1", "ftp://tools:8787"]) {
      expect(() => relayToolMcpServer("scout", url)).toThrow("RELAY_TOOL_URL must be an http(s) origin");
    }
  });
});

describe("Relay signing owner", () => {
  const OWNER = "1457cb2a-7543-4b48-8854-a63cd160241f";

  it("signs only for the bot's own owner on a thread that owner holds", () => {
    expect(relaySigningOwner({ ownerUserId: OWNER }, OWNER)).toBe(OWNER);
  });

  it("refuses a thread belonging to another owner or to no one", () => {
    expect(relaySigningOwner({ ownerUserId: OWNER }, "9c858901-8a57-4791-81fe-4c455b099bc9")).toBeUndefined();
    expect(relaySigningOwner({ ownerUserId: OWNER }, undefined)).toBeUndefined();
    expect(relaySigningOwner({}, OWNER)).toBeUndefined();
  });
});

describe("Relay MCP bot binding", () => {
  it("mounts the harness proxy in the bot's own role beside other custom servers", () => {
    const notes = { type: "http" as const, url: "https://notes.example.test/mcp", headers: {} };
    const mounted = bindRelayMcpForBot("scout", { notes }, proxySpec);
    expect(Object.keys(mounted).sort()).toEqual(["notes", "relay-scout"]);
    expect(mounted["relay-scout"]).toEqual(proxySpec);
    expect(mounted.notes).toEqual(notes);
  });

  it("mounts no Relay route for another role or a spoofed configured route", () => {
    // A speculative spec for a different role is never mounted under this role.
    expect(bindRelayMcpForBot("mercury", {}, proxySpecFor("scout"))).toEqual({});
    // No spec, no Relay route.
    expect(bindRelayMcpForBot("scout", {}, undefined)).toEqual({});
    expect(bindRelayMcpForBot(undefined, {}, proxySpecFor("scout"))).toEqual({});
    // A configured entry that names a Relay route is dropped, not mounted.
    const forged = { type: "http" as const, url: "http://127.0.0.1:8787/mcp/scout", headers: {} };
    expect(bindRelayMcpForBot("scout", { "relay-scout": forged }, undefined)).toEqual({});
    const renamed = { type: "http" as const, url: "http://127.0.0.1:8787/mcp/curator", headers: {} };
    expect(bindRelayMcpForBot("scout", { notes: renamed }, undefined)).toEqual({});
  });
});
