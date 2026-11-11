/** Browser-takeover card creation: tool layer -> BFF -> harness.
 *
 * POST /api/internal/browser-takeover — loopback-only. The tool layer never
 * reaches the harness directly; the BFF terminates tool-facing auth and
 * proxies over loopback. Dual auth mirrors the Scribe join route: the shared
 * BFF capability plus the per-turn actor assertion, both re-checked here.
 *
 * The harness owns the card and the continuation; this route validates and
 * hands the safe metadata to the store.
 */
import type { IncomingMessage } from "node:http";

import { browserTakeoverCardSchema } from "../../shared/takeover-wire.ts";

import { isLoopbackHost, isProxied } from "../request-auth.ts";
import { verifyActorAssertion } from "../relay-mcp.ts";
import type { BotRecord } from "../store.ts";
import { bearerCapabilityMatches, capabilityHash } from "./portal-session.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const BROWSER_TAKEOVER_PATH = "/api/internal/browser-takeover";
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 1_500_000;

/** Accept only a PNG/JPEG data URL, strictly base64, within the size cap,
 * with bytes that match the declared image type. A bad preview is dropped;
 * the card itself still goes through. */
function parseTakeoverScreenshot(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!match) return null;
  const [, kind, base64] = match;
  if (base64.length % 4 !== 0) return null;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) return null;
  if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) return null;
  const png = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((kind === "png" && !png) || (kind === "jpeg" && !jpeg)) return null;
  return `data:image/${kind};base64,${base64}`;
}

export type BrowserTakeoverActor = {
  userId: string;
  botId: string;
  threadId: string;
  agent: "scout" | "mercury" | "curator";
};

export interface BrowserTakeoverCreateInput {
  sessionId: string;
  generation: number;
  title: string;
  expiresAt: string;
  /** Validated one-shot PNG/JPEG data URL, or absent when the capture failed. */
  screenshot?: string;
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isLoopbackHost(normalized);
}

function reject(ctx: RouteContext, status: number, body: unknown): void {
  ctx.res.setHeader("connection", "close");
  ctx.json(ctx.res, status, body);
}

export function createBrowserTakeoverRoutes(options: {
  store: { bot(id: string): Pick<BotRecord, "relayAgent" | "ownerUserId"> | null };
  capability: string | undefined;
  actorSecret: string | undefined;
  /** Persist the card. Returns null when the source conversation does not
   * belong to the sender or the actor is not a research bot. */
  create: (actor: BrowserTakeoverActor, input: BrowserTakeoverCreateInput) => { messageId: string } | null;
}): RouteHandler {
  const capabilityReady = typeof options.capability === "string" && Buffer.byteLength(options.capability) >= 32;
  const expectedHash = capabilityHash(options.capability ?? "");

  return async (ctx) => {
    if (ctx.path !== BROWSER_TAKEOVER_PATH) return PASS;
    ctx.res.setHeader("cache-control", "no-store");

    if (isProxied(ctx.req) || !isLoopbackHost(header(ctx.req.headers.host)) || !loopbackPeer(ctx.req)) {
      return reject(ctx, 403, { error: "forbidden" });
    }
    if (ctx.method !== "POST") {
      ctx.res.setHeader("allow", "POST");
      return reject(ctx, 405, { error: "method not allowed" });
    }
    if (!/^application\/json\b/i.test(String(ctx.req.headers["content-type"] ?? ""))) {
      return reject(ctx, 415, { error: "send the request as JSON" });
    }
    if (!capabilityReady) return reject(ctx, 503, { error: "browser takeover is unavailable" });
    if (!bearerCapabilityMatches(ctx.req, expectedHash)) return reject(ctx, 401, { error: "unauthorized" });

    let actor: BrowserTakeoverActor;
    try {
      actor = verifyActorAssertion(header(ctx.req.headers["x-relay-actor-user"]), options.actorSecret);
    } catch {
      return reject(ctx, 401, { error: "unauthorized" });
    }
    const bot = options.store.bot(actor.botId);
    if (!bot || bot.relayAgent !== "scout" || bot.ownerUserId !== actor.userId) {
      return reject(ctx, 403, { error: "browser takeover is a research-only action" });
    }

    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, MAX_BODY_BYTES);
    } catch {
      return reject(ctx, 400, { error: "invalid request body" });
    }
    const parsed = browserTakeoverCardSchema.safeParse(raw);
    if (!parsed.success) return reject(ctx, 400, { error: "invalid browser takeover request" });

    const screenshot = parseTakeoverScreenshot(parsed.data.screenshot);
    const result = options.create(actor, {
      sessionId: parsed.data.session_id,
      generation: parsed.data.generation,
      title: parsed.data.title,
      expiresAt: parsed.data.expires_at,
      ...(screenshot ? { screenshot } : {}),
    });
    if (!result) return reject(ctx, 403, { error: "source conversation does not belong to sender" });
    return ctx.json(ctx.res, 201, { message_id: result.messageId });
  };
}
