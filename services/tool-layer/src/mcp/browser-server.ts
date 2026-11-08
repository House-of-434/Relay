import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeBrowser } from "../domain/permissions.js";
import type { BladeBrowserPool, ExtractKind, ReadMode } from "../infra/bladebro.js";
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

/** Scout's browser: interactive navigation, persistent page state, and
 * site-aware structured extraction inside the calling user's own browser
 * workspace. */
export function registerBrowserTools(server: McpServer, agent: Agent, context: BladeBrowserContext): void {
  const { pool, userId, threadId, actorAssertion, bffInternalUrl, bffCapability, sessions, displays } = context;
  const takeover = new RelayBrowserTakeoverClient({ bffInternalUrl, capability: bffCapability });
  const guardTakeover = (): void => {
    if (sessions?.isUserTakeover(userId)) throw new Error("browser is in human takeover; agent input is paused");
  };

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a URL in the persistent research browser. Use for clicking, navigating, expanding content, interacting with pages, or maintaining state across steps. Returns bounded page text.",
      inputSchema: { url: z.string().min(1).max(2048) },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      try {
        authorizeBrowser(agent, "open");
        guardTakeover();
        const result = await pool.open(userId, url);
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
        const result = await pool.read(userId, mode as ReadMode, query, artifact, offset, limit);
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
        const result = await pool.extract(userId, url ?? null, (kind ?? "auto") as ExtractKind);
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
        "Ask the person to sign in to a site the research browser cannot pass (login, Cloudflare, auth wall). Opens one persistent browser session and a sign-in card in this chat; the person signs in there and your turn ends. Relay resumes this task automatically when they finish or dismiss it. Never ask for or accept credentials in chat.",
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
      let displayStarted = false;
      try {
        authorizeBrowser(agent, "request_human");
        const host = new URL(url).hostname.slice(0, 120);
        // Display first: a capacity refusal must not release a session this
        // call did not create.
        const lease = await displays.acquire(userId);
        displayStarted = true;
        const session = sessions.requestHuman(userId, threadId);
        sessionId = session.id;
        generation = session.generation;
        await pool.headfulOpen(userId, url, lease.display);
        const expiresAt = new Date(Date.now() + LOGIN_TAKEOVER_TTL_MS).toISOString();
        await takeover.requestCard(actorAssertion, {
          requestKey: takeoverRequestKey(userId, session.id, session.generation),
          sessionId: session.id,
          generation: session.generation,
          title: `Sign in to ${host}`,
          description: `${reason ? `${reason} ` : ""}The research browser needs you to sign in to ${host}. Use the panel in this chat; your credentials never reach the assistant.`,
          expiresAt,
        });
        return {
          content: [
            {
              type: "text",
              text: "A sign-in panel is ready in this chat. End this turn; Relay resumes the task automatically after the person signs in, dismisses it, or the panel expires.",
            },
          ],
        };
      } catch (error) {
        // Failed card creation must not leave a browser, display, or takeover
        // behind. Release is best-effort; the original error is what matters.
        if (sessionId) {
          try { sessions.release(sessionId, generation); } catch { /* already settled */ }
        }
        if (displayStarted) displays.release(userId);
        await pool.stopWorkspace(userId).catch(() => {});
        return toolError(error);
      }
    },
  );

}
