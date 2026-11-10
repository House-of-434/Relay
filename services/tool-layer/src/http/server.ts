import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { connect as netConnect } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { IngestConflictError, RelayDatabase } from "../infra/database.js";
import type { RelayActorContext } from "../infra/actor-assertion.js";
import { authorizeIngest, isAgent } from "../domain/permissions.js";
import { RelayGmailClient } from "../infra/gmail.js";
import { RelayCalendarClient } from "../infra/calendar.js";
import { RelayScribeJoinClient } from "../infra/scribe.js";
import { BladeBrowserPool } from "../infra/bladebro.js";
import { TakeoverSessionManager } from "../infra/takeover-session.js";
import { TakeoverDisplayPool } from "../infra/takeover-display.js";
import { acquireInteractiveLease } from "../infra/takeover-lease.js";
import { ViewerTokens } from "../infra/takeover-viewer.js";
import { TinyFishSearchProvider } from "../infra/search.js";
import { TinyFishFetchProvider } from "../infra/fetch.js";
import { ArxivProvider } from "../infra/arxiv.js";
import { SecProvider } from "../infra/sec.js";
import { RelayGitHubClient } from "../infra/github.js";
import { RelayNotionClient } from "../infra/notion.js";
import { ConnectorStateClient } from "../infra/connector-state.js";
import { createAgentMcpServer, type ConnectorToolContext } from "../mcp/agent-server.js";
import { databaseToolCallLogger } from "../mcp/tool-log.js";
import { arxivConfig, assertValidPort, bffConfig, bladeConfig, ingestCapability, searchConfig, secConfig, toolHost, toolPort } from "../config.js";

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

/**
 * Orphan-sweep route: a freshly-booted capture worker finalizes rows a
 * previous, dead generation left live (it owns zero sessions at boot, so any
 * live row is an orphan holding the room's meetings_live_once slot). Same
 * ingest capability as the write route — it is the same writer — and no actor;
 * there is no agent here.
 */
async function handleSweep(
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
  let reason = "capture worker restarted; the recording session did not survive";
  if (/^application\/json\b/i.test(typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "")) {
    try {
      const raw = await readIngestBody(request);
      if (raw && typeof raw === "object" && typeof (raw as { reason?: unknown }).reason === "string") {
        reason = (raw as { reason: string }).reason.slice(0, 200);
      }
    } catch {
      sendJson(response, 400, { error: "invalid sweep body" });
      return;
    }
  }
  try {
    const result = await database.sweepOrphanedMeetings(reason);
    sendJson(response, 200, { swept: result.partial + result.failed, ...result });
  } catch {
    sendJson(response, 500, { error: "sweep failed" });
  }
}

/**
 * Shared-mailbox sender resolution: the harness turns a sender's email into
 * the canonical user id through the auth table (confirmed, non-deleted,
 * domain-allowed). Service-to-service only, bound to the internal capability
 * the harness and Tool Layer already share. There is no agent and no actor
 * here; the harness passes only an email it extracted from the mail header.
 */
async function handleMemberLookup(
  request: IncomingMessage,
  response: ServerResponse,
  database: RelayDatabase,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  const capability = bffConfig().capability;
  if (!capability) {
    sendJson(response, 503, { error: "member lookup is not configured" });
    return;
  }
  if (!ingestCapabilityMatches(ingestBearerToken(request), capability)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  let body: unknown;
  try {
    body = await readIngestBody(request);
  } catch {
    sendJson(response, 400, { error: "invalid member lookup body" });
    return;
  }
  const email = body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    sendJson(response, 400, { error: "invalid email" });
    return;
  }
  // No caller-supplied domain list: Supabase's sign-up hook IS the boundary, and
  // the RPC only returns confirmed, non-deleted, non-banned users.
  try {
    const userId = await database.memberByEmail(email.trim().toLowerCase());
    sendJson(response, 200, { userId });
  } catch {
    sendJson(response, 502, { error: "member lookup failed" });
  }
}

/** Serve noVNC's static files from the session's websockify, which also
 * hosts the RFB bridge. Token already validated by the caller; `path` is a
 * relative file under the noVNC web root. */
async function proxyNovnc(
  response: ServerResponse,
  userId: string,
  path: string,
): Promise<void> {
  const port = sharedDisplays?.wsPortFor(userId);
  if (!port) {
    sendJson(response, 503, { error: "live display is not running" });
    return;
  }
  if (path.includes("..") || path.startsWith("/")) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  const upstream = httpRequest(
    { host: "127.0.0.1", port, method: "GET", path: `/${path}` },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) sendJson(response, 502, { error: "viewer upstream failed" });
    else response.end();
  });
  upstream.end();
}

/** WebSocket upgrade for the viewer: authenticate the token, then bridge raw
 * bytes to websockify's /websockify endpoint. No CDP is exposed. */
function proxyViewerUpgrade(
  request: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = /^\/_viewer\/([0-9a-f]{32})\/ws$/.exec(url.pathname);
  const token = match && sharedViewerTokens?.find(match[1]!);
  const port = token && sharedDisplays?.wsPortFor(token.userId);
  if (!token || !port) {
    socket.destroy();
    return;
  }
  const upstream = netConnect(port, "127.0.0.1", () => {
    const headerLines = Object.entries(request.headers)
      .filter(([key]) => key !== "host")
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headerLines}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

/** One interactive-session manager for the process, wired to the
 * cross-process lease and the single close path that tears down runtime
 * resources (never the persistent profile). */
function ensureTakeoverSessions(): TakeoverSessionManager {
  if (sharedTakeoverSessions) return sharedTakeoverSessions;
  const blade = bladeConfig();
  sharedTakeoverSessions = new TakeoverSessionManager({
    maxConcurrent: blade.takeoverMaxConcurrent,
    idleMs: blade.takeoverIdleMs,
    maxLifetimeMs: blade.takeoverMaxLifetimeMs,
    leaseFor: (userId) =>
      acquireInteractiveLease({
        dataRoot: blade.dataRoot,
        userId,
        maxLifetimeMs: blade.takeoverMaxLifetimeMs,
      }),
    onEvent: (event) => {
      // One close path for release, dismiss, expiry, idle and the hard cap.
      sharedViewerTokens?.revokeSession(event.sessionId);
      sharedDisplays?.release(event.userId);
      void sharedBladePool?.stopWorkspace(event.userId).catch(() => {});
    },
  });
  return sharedTakeoverSessions;
}

/** Browser-takeover control plane for the harness: mint a viewer for a live
 * takeover, hand the page back to the agent, or release it. All routes are
 * authenticated by the same signed actor assertion the MCP calls use, and the
 * session must belong to the asserted user. */
async function handleBrowserTakeover(
  request: IncomingMessage,
  response: ServerResponse,
  database: RelayDatabase,
  pathname: string,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  const header = request.headers["x-relay-actor-user"];
  if (typeof header !== "string") {
    sendJson(response, 401, { error: "authenticated actor required" });
    return;
  }
  let actor: { userId: string; botId: string; threadId: string };
  try {
    const verified = database.authenticateActorAssertion(header);
    actor = { userId: verified.userId, botId: verified.botId, threadId: verified.threadId };
  } catch {
    sendJson(response, 401, { error: "invalid actor context" });
    return;
  }
  const userId = actor.userId;
  let body: unknown;
  try {
    body = await readIngestBody(request);
  } catch {
    sendJson(response, 400, { error: "invalid request body" });
    return;
  }
  const sessionId = body && typeof body === "object" ? (body as { session_id?: unknown }).session_id : undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
    sendJson(response, 400, { error: "invalid session id" });
    return;
  }
  const generation = body && typeof body === "object" ? (body as { generation?: unknown }).generation : undefined;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    sendJson(response, 400, { error: "invalid generation" });
    return;
  }
  const sessions = ensureTakeoverSessions();
  sharedViewerTokens ??= new ViewerTokens();
  sessions.sweepExpired();
  const session = sessions.ownedSession(userId, sessionId);
  // Control-plane calls are bound to the originating bot + thread, not just
  // the person: no other task may drive or settle this page.
  if (session && (session.botId !== actor.botId || session.threadId !== actor.threadId)) {
    sendJson(response, 403, { error: "this sign-in belongs to another task" });
    return;
  }

  if (pathname === "/internal/browser-takeover/viewer") {
    if (!session || session.state !== "user_takeover" || session.generation !== generation) {
      sendJson(response, 409, { error: "this sign-in is no longer active" });
      return;
    }
    sessions.touchSession(sessionId);
    if (!session.display) {
      // Local development: the real Chrome window is already on the host.
      sendJson(response, 200, { path: "", local: true });
      return;
    }
    const token = sharedViewerTokens.mint(session.id, userId, session.generation);
    sendJson(response, 200, {
      path: `/_viewer/${token.value}`,
      expires_at: new Date(token.expiresAt).toISOString(),
    });
    return;
  }

  if (pathname === "/internal/browser-takeover/handback") {
    if (!session) {
      sendJson(response, 200, { handed_back: false, url: "" });
      return;
    }
    if (session.generation !== generation) {
      sendJson(response, 409, { error: "this sign-in was superseded" });
      return;
    }
    if (session.state !== "user_takeover") {
      // Already handed back: idempotent, and the URL is still available.
      sharedViewerTokens.revokeSession(sessionId);
      const url = (await sharedBladePool?.currentUrl(userId, session.display)) ?? "";
      sendJson(response, 200, { handed_back: true, url });
      return;
    }
    try {
      sessions.handBack(sessionId, generation);
      console.log(`[takeover] handback session=${sessionId} bot=${actor.botId} thread=${actor.threadId}`);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "this sign-in is no longer active" });
      return;
    }
    // The person is done driving: revoke their token, keep the browser and
    // page alive for the agent.
    sharedViewerTokens.revokeSession(sessionId);
    const url = (await sharedBladePool?.currentUrl(userId, session.display)) ?? "";
    sendJson(response, 200, { handed_back: true, url });
    return;
  }

  if (!session) {
    // The card's duplicate terminal request: already released.
    sendJson(response, 200, { released: false });
    return;
  }
  if (session.generation !== generation) {
    sendJson(response, 409, { error: "this sign-in was superseded" });
    return;
  }
  sessions.release(sessionId, generation, "released");
  sendJson(response, 200, { released: true });
}

let sharedBladePool: BladeBrowserPool | null = null;
let sharedTakeoverSessions: TakeoverSessionManager | null = null;
let sharedDisplays: TakeoverDisplayPool | null = null;
let sharedViewerTokens: ViewerTokens | null = null;
let sharedArxiv: { userAgent: string; provider: ArxivProvider } | null = null;
let sharedSec: { userAgent: string; provider: SecProvider } | null = null;

/** Build the research-connector tool contexts. arXiv and SEC are public
 * built-ins, always offered to an authenticated Scout (SEC still fails closed
 * when its required fair-access User-Agent is unconfigured). GitHub is a
 * user-managed connection, so it is offered only when the BFF reports a linked
 * installation for this actor. */
async function buildConnectors(
  actorAssertion: string,
  bffInternalUrl: string,
  capability: string | undefined,
): Promise<ConnectorToolContext> {
  const connectors: ConnectorToolContext = {};

  const { userAgent: arxivUserAgent } = arxivConfig();
  if (!sharedArxiv || sharedArxiv.userAgent !== arxivUserAgent) {
    sharedArxiv = { userAgent: arxivUserAgent, provider: new ArxivProvider({ userAgent: arxivUserAgent }) };
  }
  connectors.arxiv = { provider: sharedArxiv.provider };

  const { userAgent: secUserAgent } = secConfig();
  if (secUserAgent) {
    if (!sharedSec || sharedSec.userAgent !== secUserAgent) {
      sharedSec = { userAgent: secUserAgent, provider: new SecProvider({ userAgent: secUserAgent }) };
    }
    connectors.sec = { provider: sharedSec.provider };
  } else {
    console.error("[relay-tools] RELAY_SEC_USER_AGENT is unset; not offering SEC tools");
  }

  const state = await new ConnectorStateClient({ bffInternalUrl, capability }).state(actorAssertion);
  if (state.github.connected) {
    connectors.github = {
      client: new RelayGitHubClient({ bffInternalUrl, capability }),
      actorAssertion,
    };
  }
  if (state.notion.connected) {
    connectors.notion = {
      client: new RelayNotionClient({ bffInternalUrl, capability }),
      actorAssertion,
    };
  }
  return connectors;
}

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

      if (url.pathname === "/internal/browser-takeover/viewer" || url.pathname === "/internal/browser-takeover/release" || url.pathname === "/internal/browser-takeover/handback") {
        await handleBrowserTakeover(request, response, database, url.pathname);
        return;
      }

      const viewerMatch = /^\/_viewer\/([0-9a-f]{32})(?:\/(novnc\/.*|heartbeat))?$/.exec(url.pathname);
      if (viewerMatch) {
        const tokenValue = viewerMatch[1]!;
        const action = viewerMatch[2];
        sharedViewerTokens ??= new ViewerTokens();
        const token = sharedViewerTokens.find(tokenValue);
        if (!token) {
          sendJson(response, 404, { error: "viewer link expired or invalid" });
          return;
        }
        if (request.method === "GET" && !action) {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><title>Live browser</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; background: #000; color: #eee; }
  #screen { width: min(1200px, 96vw); height: min(675px, 54vw); border: 1px solid #444; background: #000; }
  #status { color: #9f9; } #status.err { color: #f99; }
  #embed-status { display: none; }
  body.embed #embed-status {
    display: block; position: fixed; top: 12px; left: 12px; z-index: 10;
    padding: 6px 10px; border-radius: 8px; background: rgba(0,0,0,.72);
    font-size: 12px; color: #ddd; pointer-events: none;
  }
  body.embed.connected #embed-status { display: none; }
  body.embed { margin: 0; overflow: hidden; }
  body.embed #chrome { display: none; }
  body.embed #screen { width: 100vw; height: 100vh; border: 0; }
</style>
<body>
<script>if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embed");</script>
<div id="chrome">
  <h3>Live browser — agent is paused</h3>
  <p id="status">Connecting…</p>
  <p>Click the screen, then complete the step or make your changes. Use the card's button when finished.</p>
</div>
<div id="screen"></div>
<div id="embed-status">Connecting…</div>

<script type="module">
import RFB from "/_viewer/${tokenValue}/novnc/core/rfb.js";
const statusEl = document.getElementById("status");
const embedStatusEl = document.getElementById("embed-status");
const setStatus = (text, error) => {
  statusEl.textContent = text; statusEl.className = error ? "err" : "";
  if (embedStatusEl) { embedStatusEl.textContent = text; embedStatusEl.style.color = error ? "#f99" : "#ddd"; }
};
const target = document.getElementById("screen");
const notify = (type) => {
  try { window.parent.postMessage({ type }, window.location.origin); } catch { /* parent gone */ }
};
let rfb = null;
try {
  rfb = new RFB(target, (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/_viewer/${tokenValue}/ws");
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.showDotCursor = true;
  rfb.addEventListener("connect", () => { document.body.classList.add("connected"); setStatus("Connected", false); notify("relay-takeover-viewer-ready"); rfb.focus(); });
  rfb.addEventListener("disconnect", (e) => { document.body.classList.remove("connected"); setStatus("Disconnected" + (e.detail && e.detail.clean ? "" : " (connection lost)"), true); notify("relay-takeover-viewer-error"); });
  rfb.addEventListener("credentialsrequired", () => { document.body.classList.remove("connected"); setStatus("Viewer refused", true); notify("relay-takeover-viewer-error"); });
} catch (e) {
  document.body.classList.remove("connected"); setStatus("Viewer error: " + e.message, true); notify("relay-takeover-viewer-error");
}
setInterval(() => { fetch("/_viewer/${tokenValue}/heartbeat", { method: "POST" }).catch(() => {}); }, 30_000);
</script>
</body>`);
          return;
        }
        if (request.method === "GET" && action && action.startsWith("novnc/")) {
          await proxyNovnc(response, token.userId, action.slice("novnc/".length));
          return;
        }
        if (request.method === "POST" && action === "heartbeat") {
          // Keep the idle clock alive while the person is using the viewer;
          // the hard cap is never extended by activity.
          ensureTakeoverSessions().touchSession(token.sessionId);
          sendJson(response, 200, { ok: true });
          return;
        }
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const match = /^\/mcp\/(scout|mercury|curator)$/.exec(url.pathname);
      if (url.pathname === "/internal/transcripts") {
        await handleIngest(request, response, database);
        return;
      }
      if (url.pathname === "/internal/transcripts/sweep") {
        await handleSweep(request, response, database);
        return;
      }
      if (url.pathname === "/internal/member-by-email") {
        await handleMemberLookup(request, response, database);
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
      // The route and the signed assertion must agree on the agent: an
      // assertion signed for one role must never reach another role's tools.
      if (actor.actor.agent !== agentName) {
        sendJson(response, 401, { error: "actor assertion does not match this agent route" });
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

      // Meeting capture goes through the BFF like Gmail and Calendar: the
      // harness edge gate requires a loopback Host, which a compose-network
      // caller can never present, so the BFF terminates tool-facing auth and
      // proxies to the harness over loopback. Same capability, same assertion.
      const scribe = actor.actorAssertion
        ? { client: new RelayScribeJoinClient({ bffInternalUrl, capability }), actorAssertion: actor.actorAssertion }
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
      ensureTakeoverSessions();
      sharedViewerTokens ??= new ViewerTokens();
      sharedDisplays ??= new TakeoverDisplayPool({ maxSlots: blade.takeoverMaxConcurrent });
      const browser = sharedBladePool
        ? {
            pool: sharedBladePool,
            userId,
            botId: actor.actor.botId,
            threadId: actor.actor.threadId,
            actorAssertion: actor.actorAssertion ?? "",
            bffInternalUrl,
            bffCapability: capability,
            sessions: ensureTakeoverSessions(),
            displays: sharedDisplays,
          }
        : undefined;

      const searchConfigValue = searchConfig();
      const search = {
        provider: new TinyFishSearchProvider({
          binary: searchConfigValue.binary,
          apiKey: searchConfigValue.apiKey,
          home: searchConfigValue.home,
        }),
      };
      // Fetch shares TinyFish's CLI, credential, and probe with search.
      const fetch = {
        provider: new TinyFishFetchProvider({
          binary: searchConfigValue.binary,
          apiKey: searchConfigValue.apiKey,
          home: searchConfigValue.home,
        }),
      };

      // Per-user connector enablement comes from the BFF; a disabled connector
      // is never registered. GitHub additionally requires a connected install.
      const connectors = actor.actorAssertion
        ? await buildConnectors(actor.actorAssertion, bffInternalUrl, capability)
        : undefined;

      const mcp = createAgentMcpServer(
        agentName,
        { userId, botId: actor.actor.botId, threadId: actor.actor.threadId },
        database, gmail, calendar, browser, search, fetch,
        databaseToolCallLogger(database, agentName, userId),
        scribe,
        connectors,
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
  httpServer.on("upgrade", (request, socket, head) => {
    proxyViewerUpgrade(request, socket, head);
  });
  // Idle/hard-cap reclaim for interactive sessions. The timer owns no state;
  // closing the server clears it.
  const sessionSweep = setInterval(() => ensureTakeoverSessions().sweepExpired(), 60_000);
  sessionSweep.unref?.();
  httpServer.on("close", () => clearInterval(sessionSweep));
  return httpServer;
}
