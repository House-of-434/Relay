import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { RelayDatabase } from "../infra/database.js";
import { isAgent } from "../domain/permissions.js";
import { RelayGmailClient } from "../infra/gmail.js";
import { RelayCalendarClient } from "../infra/calendar.js";
import { BladeBrowserPool } from "../infra/bladebro.js";
import { TinyFishSearchProvider } from "../infra/search.js";
import { createAgentMcpServer } from "../mcp/agent-server.js";
import { assertValidPort, bffConfig, bladeConfig, searchConfig, toolHost, toolPort } from "../config.js";

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) throw new Error("Authorization must contain a Bearer access token");
  return match[1]!;
}

async function mcpActor(request: IncomingMessage, database: RelayDatabase): Promise<{
  userId: string | null;
  actorAssertion: string | undefined;
}> {
  const token = bearerToken(request);
  if (token) return { userId: await database.authenticateUser(token), actorAssertion: undefined };
  const header = request.headers["x-relay-actor-user"];
  if (header === undefined) return { userId: null, actorAssertion: undefined };
  if (typeof header !== "string") throw new Error("actor context must contain one signed assertion");
  // The raw assertion is forwarded so the BFF can verify the same signature
  // itself; the BFF never trusts that this process called it.
  return { userId: database.authenticateActorAssertion(header), actorAssertion: header };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

let sharedBladePool: BladeBrowserPool | null = null;

export async function createRelayToolServer(
  database: RelayDatabase = new RelayDatabase(),
  requestedPort = toolPort(),
) {
  await database.verifyRelayProject();

  const httpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { app: "relay-tools", status: "ok" });
        return;
      }

      // Live research frame: the calling user's workspace screenshot for
      // the harness live view. Same actor authentication as the MCP
      // routes, so a caller can only ever see their own workspace.
      if (request.method === "GET" && url.pathname === "/workspace/vision") {
        let actor: { userId: string | null; actorAssertion: string | undefined };
        try {
          actor = await mcpActor(request, database);
        } catch (error) {
          sendJson(response, 401, { error: error instanceof Error ? error.message : "invalid actor context" });
          return;
        }
        if (!actor.userId) {
          sendJson(response, 401, { error: "research view requires an authenticated actor" });
          return;
        }
        const blade = bladeConfig();
        sharedBladePool ??= new BladeBrowserPool({
          dataRoot: blade.dataRoot,
          binary: blade.binary,
          chromePath: blade.chromePath,
          proxy: blade.proxy,
          timezone: blade.timezone,
          locale: blade.locale,
        });
        try {
          const png = await sharedBladePool.vision(actor.userId);
          response.writeHead(200, { "content-type": "image/png", "content-length": png.length });
          response.end(png);
        } catch (error) {
          sendJson(response, 502, { error: error instanceof Error ? error.message.slice(0, 300) : "vision failed" });
        }
        return;
      }

      const match = /^\/mcp\/(scout|mercury|curator)$/.exec(url.pathname);
      if (request.method !== "POST" || !match) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const agentName = match[1]!;
      if (!isAgent(agentName)) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      let actor: { userId: string | null; actorAssertion: string | undefined };
      try {
        actor = await mcpActor(request, database);
      } catch (error) {
        sendJson(response, 401, { error: error instanceof Error ? error.message : "invalid actor context" });
        return;
      }

      // Gmail and Calendar are exposed only to a caller that proved a signed
      // actor identity; without one there is no mailbox or calendar the BFF
      // could safely derive.
      const { bffInternalUrl, capability } = bffConfig();
      const gmail = actor.actorAssertion
        ? { client: new RelayGmailClient({ bffInternalUrl, capability }), actorAssertion: actor.actorAssertion }
        : undefined;
      const calendar = actor.actorAssertion
        ? { client: new RelayCalendarClient({ bffInternalUrl, capability }), actorAssertion: actor.actorAssertion }
        : undefined;

      // The research browser needs an authenticated user to scope the daemon
      // workspace. The pool is process-shared so daemon tracking survives
      // across requests. Search carries no per-user state, so the provider
      // is built unconditionally — visibility is decided per agent below.
      const blade = bladeConfig();
      if (actor.userId) {
        sharedBladePool ??= new BladeBrowserPool({
          dataRoot: blade.dataRoot,
          binary: blade.binary,
          chromePath: blade.chromePath,
          proxy: blade.proxy,
          timezone: blade.timezone,
          locale: blade.locale,
        });
      }
      const browser =
        actor.userId && sharedBladePool ? { pool: sharedBladePool, userId: actor.userId } : undefined;

      const searchConfigValue = searchConfig();
      const search = {
        provider: new TinyFishSearchProvider({
          binary: searchConfigValue.binary,
          apiKey: searchConfigValue.apiKey,
          home: searchConfigValue.home,
        }),
      };

      const mcp = createAgentMcpServer(agentName, actor.userId, database, gmail, calendar, browser, search);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        console.error("[relay-tools] MCP request failed", error);
        if (!response.headersSent) sendJson(response, 500, { error: "MCP request failed" });
      } finally {
        await transport.close();
        await mcp.close();
      }
    })().catch((error) => {
      console.error("[relay-tools] HTTP request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "request failed" });
    });
  });

  assertValidPort(requestedPort);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, toolHost(), () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return httpServer;
}
