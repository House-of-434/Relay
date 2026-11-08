import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeBrowser } from "../domain/permissions.js";
import type { BladeBrowserPool, BrowserActInput, ExtractKind, ReadMode } from "../infra/bladebro.js";
import type { LoginSessionManager } from "../infra/login-session.js";
import type { LoginDisplayPool } from "../infra/login-display.js";
import { LOGIN_TAKEOVER_TTL_MS } from "../infra/login-session.js";
import { RelayBrowserTakeoverClient, takeoverRequestKey } from "../infra/browser-takeover.js";

export interface BladeBrowserContext {
  pool: BladeBrowserPool;
  userId: string;
  botId: string;
  threadId: string;
  actorAssertion: string;
  bffInternalUrl: string;
  bffCapability: string | undefined;
  sessions?: LoginSessionManager;
  displays?: LoginDisplayPool;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "request refused";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function withArtifactNote(text: string, artifact: string | undefined): string {
  if (!artifact) return text;
  return `${text}\n\nFull output is in workspace artifact ${artifact} (this user only); use browser_read with mode "artifact" to page it.`;
}

const READ_MODES = ["content", "outline", "find", "artifact"] as const;
const EXTRACT_KINDS = ["auto", "links", "forms"] as const;
const ACT_ACTIONS = ["click", "type", "select", "press", "scroll"] as const;

/** Scout's browser: interactive navigation, persistent page state, and
 * site-aware structured extraction inside the calling user's own browser
 * workspace. The interactive lane (a handed-back session) additionally
 * allows native-CDP actions, bound to this bot and thread only. */
export function registerBrowserTools(server: McpServer, agent: Agent, context: BladeBrowserContext): void {
  const { pool, userId, botId, threadId, actorAssertion, bffInternalUrl, bffCapability, sessions, displays } = context;
  const takeover = new RelayBrowserTakeoverClient({ bffInternalUrl, capability: bffCapability });
  const actor = { userId, botId, threadId };

  const guardTakeover = (): void => {
    if (sessions?.isUserTakeover(userId)) throw new Error("browser is in human takeover; agent input is paused");
  };
  /** The live display when this exact bot/thread owns the handed-back
   * session. Unrelated tasks never attach to it. */
  const liveDisplay = (): string | undefined => {
    const session = sessions?.agentSession(actor);
    if (!session) return undefined;
    sessions?.touchByUser(userId);
    return session.display;
  };

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a URL in the persistent browser. During a handed-back sign-in session it navigates the same live page; otherwise it uses the headless research lane. Returns bounded page text.",
      inputSchema: { url: z.string().min(1).max(2048) },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      try {
        authorizeBrowser(agent, "open");
        guardTakeover();
        const result = await pool.open(userId, url, false, liveDisplay());
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_read",
    {
      description:
        "Read the current browser page: content, headings, find text, or page through a large artifact. Use the narrowest mode that answers the question.",
      inputSchema: {
        mode: z.enum(READ_MODES),
        query: z.string().min(1).max(512).optional(),
        artifact: z.string().min(1).max(256).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(32_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ mode, query, artifact, offset, limit }) => {
      try {
        authorizeBrowser(agent, "read");
        guardTakeover();
        const result = await pool.read(userId, mode as ReadMode, query, artifact, offset, limit, liveDisplay());
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_extract",
    {
      description:
        "Extract structured page data such as repository rankings, comment threads, products, links, or forms. Use when relationships between fields matter and plain text is insufficient. Reports blocked pages rather than fabricating results.",
      inputSchema: {
        url: z.string().min(1).max(2048).optional(),
        kind: z.enum(EXTRACT_KINDS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, kind }) => {
      try {
        authorizeBrowser(agent, "extract");
        guardTakeover();
        const result = await pool.extract(userId, url ?? null, (kind ?? "auto") as ExtractKind, liveDisplay());
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_act",
    {
      description:
        "Interact with the live page in a handed-back browser session: click a control, type into a field, choose a native select option, press a key, or scroll. Only available after the person hands the browser back; it never attaches to an unrelated task. Inspect the page first, and never enter credentials for the person.",
      inputSchema: {
        action: z.enum(ACT_ACTIONS),
        target: z.string().min(1).max(512).optional(),
        text: z.string().min(1).max(2000).optional(),
        option: z.string().min(1).max(200).optional(),
        key: z.string().min(1).max(40).optional(),
        dx: z.number().int().min(-4000).max(4000).optional(),
        dy: z.number().int().min(-4000).max(4000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, target, text, option, key, dx, dy }) => {
      try {
        authorizeBrowser(agent, "act");
        guardTakeover();
        const display = liveDisplay();
        if (!display) throw new Error("interactive browser is not active for this task; call browser_request_human first");
        const input: BrowserActInput = { action, target, text, option, key, dx, dy };
        const result = await pool.act(userId, input, display);
        return { content: [{ type: "text", text: withArtifactNote(result.text, result.artifact) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_request_human",
    {
      description:
        "Ask the person to take over the live browser — a login/Cloudflare/auth wall, or any step only they can complete. Opens one persistent browser session and a card in this chat; the person signs in (or just hands it back) and your turn ends. Relay resumes this task on the same page. Never ask for or accept credentials in chat.",
      inputSchema: {
        url: z.string().min(1).max(2048),
        reason: z.string().min(1).max(240).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ url, reason }) => {
      if (!sessions || !displays) return toolError(new Error("login browser is not configured"));
      let sessionId = "";
      let generation = 0;
      let created = false;
      let displayStarted = false;
      try {
        authorizeBrowser(agent, "request_human");
        const host = new URL(url).hostname.slice(0, 120);
        const owned = sessions.requestHuman(actor, threadId);
        sessionId = owned.session.id;
        generation = owned.session.generation;
        created = owned.created;
        const lease = await displays.acquire(userId);
        displayStarted = true;
        sessions.attachDisplay(sessionId, lease.display);
        await pool.headfulOpen(userId, url, lease.display);
        const expiresAt = new Date(Date.now() + LOGIN_TAKEOVER_TTL_MS).toISOString();
        await takeover.requestCard(actorAssertion, {
          requestKey: takeoverRequestKey(userId, sessionId, generation),
          sessionId,
          generation,
          title: host,
          // The UI owns the fixed instructional copy; only the agent's own
          // reason travels with the card, once.
          description: reason?.trim().slice(0, 240) ?? "",
          expiresAt,
        });
        return {
          content: [
            {
              type: "text",
              text: "A live browser card is ready in this chat. End this turn; Relay resumes the task automatically after the person hands it back, dismisses it, or the card expires.",
            },
          ],
        };
      } catch (error) {
        // A failed card must not leave a browser, display, or takeover behind.
        if (sessionId) {
          try {
            if (created) sessions.release(sessionId, generation);
            else sessions.handBack(sessionId, generation);
          } catch { /* already settled */ }
        }
        if (displayStarted && created) displays.release(userId);
        if (created) await pool.stopWorkspace(userId).catch(() => {});
        return toolError(error);
      }
    },
  );
}
