import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { IngestConflictError, RelayDatabase } from "../infra/database.js";
import type { RelayActorContext } from "../infra/actor-assertion.js";
import { authorizeIngest, isAgent } from "../domain/permissions.js";
import { RelayGmailClient } from "../infra/gmail.js";
import { RelayCalendarClient } from "../infra/calendar.js";
import { BladeBrowserPool } from "../infra/bladebro.js";
import { TinyFishSearchProvider } from "../infra/search.js";
import { createAgentMcpServer } from "../mcp/agent-server.js";
import { databaseToolCallLogger } from "../mcp/tool-log.js";
import { assertValidPort, bffConfig, bladeConfig, ingestCapability, searchConfig, toolHost, toolPort } from "../config.js";

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

const INGEST_MAX_BODY_BYTES = 1024 * 1024;

function ingestCapabilityMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readIngestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > INGEST_MAX_BODY_BYTES) throw new Error("ingest body exceeds 1 MB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function ingestBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
}

/**
 * Capture-ingest route: the only writer of transcript tables. Capability-bound
 * (never loopback-gated, never actor-gated — there is no agent here), then
 * allowlisted per table/operation by authorizeIngest. A post may carry a
 * meeting with zero segments: status-only transitions (joining,
 * awaiting_admission, failed) all happen before any segments exist.
 */
async function handleIngest(
  request: IncomingMessage,
  response: ServerResponse,
  database: RelayDatabase,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  const capability = ingestCapability();
  if (!capability) {
    sendJson(response, 503, { error: "transcript ingest is not configured" });
    return;
  }
  if (!ingestCapabilityMatches(ingestBearerToken(request), capability)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (!/^application\/json\b/i.test(typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "")) {
    sendJson(response, 415, { error: "send the request as JSON" });
    return;
  }
  let raw: unknown;
  try {
    raw = await readIngestBody(request);
  } catch {
    sendJson(response, 400, { error: "invalid ingest body" });
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    sendJson(response, 400, { error: "ingest body must be an object" });
    return;
  }
  const { meeting, segments } = raw as { meeting?: unknown; segments?: unknown };
  if (!meeting || typeof meeting !== "object" || Array.isArray(meeting)) {
    sendJson(response, 400, { error: "ingest body requires a meeting object" });
    return;
  }
  if (segments !== undefined && !Array.isArray(segments)) {
    sendJson(response, 400, { error: "ingest segments must be an array" });
    return;
  }
  try {
    authorizeIngest("transcripts.meetings", "upsert");
    const row = await database.ingestMeeting(meeting as Record<string, unknown>);
    if (typeof row.id !== "string") {
      sendJson(response, 500, { error: "ingest failed" });
      return;
    }
    let upserted = 0;
    const list = (segments ?? []) as Record<string, unknown>[];
    if (list.length > 0) {
      authorizeIngest("transcripts.meeting_segments", "upsert");
      upserted = await database.ingestSegments(row.id, list);
    }
    sendJson(response, 200, { meeting_id: row.id, upserted });
  } catch (error) {
    if (error instanceof IngestConflictError) {
      sendJson(response, 409, { error: "live_meeting_conflict", instance_id: error.instanceId });
      return;
    }
    if (error instanceof Error && error.message.startsWith("ingest ")) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: "ingest failed" });
  }
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
      if (url.pathname === "/internal/transcripts") {
        await handleIngest(request, response, database);
        return;
      }
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
