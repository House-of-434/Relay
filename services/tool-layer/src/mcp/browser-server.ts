import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Agent } from "../domain/permissions.js";
import { authorizeBrowser, authorizeBrowserHuman } from "../domain/permissions.js";
import type { BladeBrowserPool, BrowserActInput, ExtractKind, ReadMode } from "../infra/bladebro.js";
import type { SessionLane, TakeoverSession, TakeoverSessionManager } from "../infra/takeover-session.js";
import type { TakeoverDisplayPool } from "../infra/takeover-display.js";
import { TAKEOVER_TTL_MS } from "../infra/takeover-session.js";
import { RelayBrowserTakeoverClient } from "../infra/browser-takeover.js";
import { resolveActTargets } from "../infra/credential-guard.js";

export interface BladeBrowserContext {
  pool: BladeBrowserPool;
  userId: string;
  botId: string;
  threadId: string;
  /** The provider turn that owns this tool call. Sessions never cross it. */
  turnId?: string;
  actorAssertion: string;
  bffInternalUrl: string;
  bffCapability: string | undefined;
  sessions?: TakeoverSessionManager;
  displays?: TakeoverDisplayPool;
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
const ACT_ACTIONS = ["click", "type", "fill", "select", "press", "scroll", "hover"] as const;
const LANES = ["auto", "headless", "headful"] as const;

/** The browser is one Bladebro daemon/profile per user, shared by every bot.
 * A turn leases it, may escalate headless to headful without restarting
 * Chrome, and hands the same display to a person only for a human step. */
export function registerBrowserTools(server: McpServer, agent: Agent, context: BladeBrowserContext): void {
  const { pool, userId, botId, threadId, turnId, actorAssertion, bffInternalUrl, bffCapability, sessions, displays } = context;
  const takeover = new RelayBrowserTakeoverClient({ bffInternalUrl, capability: bffCapability });
  const actor = { userId, botId, threadId, ...(turnId ? { turnId } : {}) };

  /** Run one browser operation under the user's daemon lock and turn lease.
   * `create` is false for actions that require an already-open session. */
  const withSession = async <T>(
    lane: SessionLane,
    create: boolean,
    work: (session: TakeoverSession | null) => Promise<T>,
  ): Promise<T> => {
    if (!sessions) return work(null);
    return pool.withUserLock(userId, async () => {
      sessions.sweepExpired();
      let session = sessions.sessionForActor(actor);
      if (!session) {
        if (!create) throw new Error("no browser session for this turn; call browser_open first");
        session = sessions.acquire(actor, lane).session;
      }
      sessions.claimTurn(session.id, actor.turnId);
      if (session.state === "user_takeover") {
        throw new Error("the person has control of the interactive browser; wait for them to hand it back");
      }
      sessions.markBusy(session.id, true);
      try {
        return await work(session);
      } finally {
        sessions.markBusy(session.id, false);
        sessions.touchByUser(userId);
      }
    });
  };

  /** Start headful mode on the existing daemon/page and return its display.
   * Rollback is the caller's job: state changes only after this succeeds. */
  const ensureHeadful = async (session: TakeoverSession): Promise<string> => {
    if (session.state === "agent_headful" || session.state === "user_takeover") {
      if (session.display) return session.display;
    }
    await pool.headfulOpen(userId, undefined, session.display);
    const display = await pool.headfulDisplay(userId);
    sessions?.attachDisplay(session.id, display);
    if (session.state === "agent_headless") {
      sessions?.upgradeHeadful(session.id, session.generation);
    }
    return display;
  };

  const sessionDisplay = (session: TakeoverSession | null): string | undefined => session?.display;

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a URL in the user's persistent browser. Start headless; pass lane=headful when a site blocks the headless browser or needs a signed-in session. A handed-back human session reuses the same live page. Each turn gets its own session: another task's page may still be open, so read the current page before acting and do not continue an unfinished workflow without re-establishing its state. Returns bounded page text.",
      inputSchema: {
        url: z.string().min(1).max(2048),
        lane: z.enum(LANES).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, lane }) => {
      try {
        authorizeBrowser(agent, "open");
        return await withSession(lane === "headful" ? "headful" : "headless", true, async (session) => {
          if (lane === "headful") await ensureHeadful(session!);
          const result = await pool.open(userId, url, false, sessionDisplay(session));
          return { content: [{ type: "text" as const, text: withArtifactNote(result.text, result.artifact) }] };
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_read",
    {
      description:
        "Read the current browser page: content, headings, find text, or page through a large artifact. Use the narrowest mode that answers the question. If a previous result was truncated (truncated:true or an artifact note), inspect the tool's actual pagination contract, then request the next non-overlapping range with offset/limit — never refetch the whole page. Track retrieved ranges to avoid duplicates. Continue until complete or a defined limit is reached, and report incomplete retrieval explicitly.",
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
        return await withSession("headless", true, async (session) => {
          const result = await pool.read(userId, mode as ReadMode, query, artifact, offset, limit, sessionDisplay(session));
          return { content: [{ type: "text" as const, text: withArtifactNote(result.text, result.artifact) }] };
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_extract",
    {
      description:
        "Extract structured page data such as repository rankings, comment threads, products, links, or forms. Use when relationships between fields matter and plain text is insufficient. Reports blocked pages rather than fabricating results. On a blocked page (access denied, CAPTCHA, auth-required, network or extraction failure), change the access mechanism: retry headful with browser_open lane=headful, then TinyFish CLI, then browser_request_human when only a person can complete the step. Log which fallback was used and the failure class.",
      inputSchema: {
        url: z.string().min(1).max(2048).optional(),
        kind: z.enum(EXTRACT_KINDS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, kind }) => {
      try {
        authorizeBrowser(agent, "extract");
        return await withSession("headless", true, async (session) => {
          const result = await pool.extract(userId, url ?? null, (kind ?? "auto") as ExtractKind, sessionDisplay(session));
          return { content: [{ type: "text" as const, text: withArtifactNote(result.text, result.artifact) }] };
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_upgrade_headful",
    {
      description:
        "Switch the current browser session from headless to headful without restarting Chrome. Use when a site blocks the headless browser, requires a signed-in session, or shows a Cloudflare/Turnstile challenge. Keeps the same page, profile and cookies. On success, continue with browser_act or browser_read.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => {
      try {
        authorizeBrowser(agent, "open");
        return await withSession("headful", true, async (session) => {
          const display = await ensureHeadful(session!);
          return {
            content: [{
              type: "text" as const,
              text: `Headful browser active on ${display}. The same page and Chrome profile are still mounted; continue with browser_read or browser_act.`,
            }],
          };
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_act",
    {
      description:
        "Interact with the live page in headful mode: click a control, type into a field, choose a native select option, press a key, or scroll. If the session is headless, call browser_upgrade_headful first. fill takes refs from browser_open/browser_read, for example {\"e12\":\"value\"}; for one field use type with the ref. Never enter credentials for the person.",
      inputSchema: {
        action: z.enum(ACT_ACTIONS),
        target: z.string().min(1).max(512).optional(),
        selector: z.string().min(1).max(512).optional(),
        text: z.string().min(1).max(2000).optional(),
        option: z.string().min(1).max(2000).optional(),
        key: z.string().min(1).max(40).optional(),
        fields: z.record(z.string().min(1).max(512), z.string().min(1).max(2000)).optional(),
        submit: z.string().min(1).max(512).optional(),
        dx: z.number().int().min(-4000).max(4000).optional(),
        dy: z.number().int().min(-4000).max(4000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, target, selector, text, option, key, fields, submit, dx, dy }) => {
      try {
        authorizeBrowser(agent, "act");
        return await withSession("headful", false, async (session) => {
          if (!session) throw new Error("no browser session for this turn; call browser_open first");
          if (session.state === "user_takeover") throw new Error("the person has control of the interactive browser; wait for them to hand it back");
          if (session.state === "agent_headless" || !session.display) {
            throw new Error("the browser is headless; call browser_upgrade_headful first");
          }
          const input: BrowserActInput = { action, target, selector, text, option, key, fields, submit, dx, dy };
          const guarded = action === "type" || action === "fill"
            ? resolveActTargets(input, await pool.pageModel(userId, session.display))
            : input;
          const result = await pool.act(userId, guarded, session.display);
          return { content: [{ type: "text" as const, text: withArtifactNote(result.text, result.artifact) }] };
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "browser_request_human",
    {
      description:
        "Ask the person to take over the live browser only for a step that needs a person: a password, one-time code, CAPTCHA/verification, payment, or an equivalent human requirement. A login page the agent can handle is not a human step: use browser_upgrade_headful and the persistent session first. This attaches the viewer to the existing display; it never restarts Chrome or opens a fresh browser. The person completes the step (or just hands it back) and your turn ends; Relay resumes on the same page.",
      inputSchema: {
        url: z.string().min(1).max(2048).optional(),
        reason: z.string().trim().min(1).max(240),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ url, reason }) => {
      const localBrowser = process.env.RELAY_TAKEOVER_LOCAL_BROWSER === "1" && process.env.NODE_ENV !== "production";
      if (!sessions || (!localBrowser && !displays)) return toolError(new Error("live browser is not configured"));
      let sessionId = "";
      let generation = 0;
      let human = false;
      let lease: { display: string } | null = null;
      try {
        authorizeBrowserHuman(agent);
        return await withSession("headful", true, async (session) => {
          if (!session) throw new Error("no browser session for this turn");
          sessionId = session.id;
          generation = session.generation;
          const host = url ? new URL(url).hostname.slice(0, 120) : "";
          if (localBrowser) {
            await pool.localHeadfulOpen(userId, url);
          } else {
            const display = await ensureHeadful(session);
            if (!displays) throw new Error("live browser is not configured");
            lease = await displays.acquire(userId);
            lease = await displays.attach(userId, display);
          }
          const owned = sessions.requestHuman(actor, lease?.display);
          sessionId = owned.session.id;
          generation = owned.session.generation;
          human = true;
          const screenshot = await pool.vision(userId, lease?.display).catch(() => null);
          const expiresAt = new Date(Date.now() + TAKEOVER_TTL_MS).toISOString();
          console.log(`[browser] request session=${sessionId} bot=${botId} thread=${threadId} reason=${reason.slice(0, 240)}`);
          await takeover.requestCard(actorAssertion, {
            sessionId,
            generation,
            title: host || "Live browser",
            expiresAt,
            ...(screenshot ? { screenshot: screenshot.dataUrl } : {}),
          });
          return {
            content: [{
              type: "text" as const,
              text: "A live browser card is ready in this chat. End this turn; Relay resumes automatically after the person hands it back. If they dismiss it or the card expires, the task stops and you can continue when they write again.",
            }],
          };
        });
      } catch (error) {
        // A failed card must not leave a session, viewer, or upgrade behind.
        // The daemon and profile are shared and stay alive for the next turn.
        if (human && sessionId) {
          try { sessions.handBack(sessionId, generation); } catch { /* already settled */ }
        }
        if (lease && displays) displays.release(userId);
        return toolError(error);
      }
    },
  );
}
