import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { RelayDatabase } from "../infra/database.js";
import type { RelayActorContext } from "../infra/actor-assertion.js";
import { isAgent } from "../domain/permissions.js";
import { RelayGmailClient } from "../infra/gmail.js";
import { RelayCalendarClient } from "../infra/calendar.js";
import { BladeBrowserPool } from "../infra/bladebro.js";
import { TinyFishSearchProvider } from "../infra/search.js";
import { createAgentMcpServer } from "../mcp/agent-server.js";
import { databaseToolCallLogger } from "../mcp/tool-log.js";
import { assertValidPort, bffConfig, bladeConfig, searchConfig, toolHost, toolPort } from "../config.js";

function mcpActor(request: IncomingMessage, database: RelayDatabase): {
  actor: RelayActorContext | undefined;
  actorAssertion: string | undefined;
} {
  const header = request.headers["x-relay-actor-user"];
  if (header === undefined) return { actor: undefined, actorAssertion: undefined };
  if (typeof header !== "string") throw new Error("actor context must contain one signed assertion");
  // The raw assertion is forwarded so the BFF can verify the same signature
  // itself; the BFF never trusts that this process called it.
  return { actor: database.authenticateActorAssertion(header), actorAssertion: header };
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
        const searchConfigValue = searchConfig();
        const searchProvider = new TinyFishSearchProvider({
          binary: searchConfigValue.binary,
          apiKey: searchConfigValue.apiKey,
          home: searchConfigValue.home,
        });
        const search = await searchProvider.describe().catch(
          (): import("../infra/search.js").ProviderReport => ({
            requestedProvider: "tinyfish",
            actualProvider: "none",
            fallbackUsed: false,
            providerStatus: "unavailable",
            errorSummary: "provider probe failed",
          }),
        );
        // Binary path only; apiKey/home never leave the process.
        sendJson(response, 200, { app: "relay-tools", status: "ok", searchBinary: searchConfigValue.binary, search });
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

      let actor: { actor: RelayActorContext | undefined; actorAssertion: string | undefined };
      try {
        actor = mcpActor(request, database);
      } catch (error) {
        sendJson(response, 401, { error: error instanceof Error ? error.message : "invalid actor context" });
        return;
      }

      // The HMAC actor assertion is the real boundary (compose exposes this
      // service on the container network). service_role bypasses Postgres RLS,
      // so unauthenticated relay reads would leak shared internal rows.
      if (!actor.actor) {
        sendJson(response, 401, { error: "authenticated actor required" });
        return;
      }
      const userId = actor.actor.userId;

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
      sharedBladePool ??= new BladeBrowserPool({
        dataRoot: blade.dataRoot,
        binary: blade.binary,
        chromePath: blade.chromePath,
        proxy: blade.proxy,
        timezone: blade.timezone,
        locale: blade.locale,
      });
      const browser = sharedBladePool ? { pool: sharedBladePool, userId } : undefined;

      const searchConfigValue = searchConfig();
      const search = {
        provider: new TinyFishSearchProvider({
          binary: searchConfigValue.binary,
          apiKey: searchConfigValue.apiKey,
          home: searchConfigValue.home,
        }),
      };

      const mcp = createAgentMcpServer(
        agentName,
        { userId, botId: actor.actor.botId, threadId: actor.actor.threadId },
        database, gmail, calendar, browser, search,
        databaseToolCallLogger(database, agentName, userId),
      );
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
