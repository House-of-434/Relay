/** Manual Scribe stop route: Mercury (or the requester) aborts a live capture.
 *
 * POST /api/internal/scribe/stop — same trust shape as the join route
 * (capability-authed, loopback via the BFF, verified Mercury actor). The
 * actor may stop only a capture IT requested: the live intent is matched by
 * owner and either the returned instance id or the meeting's room key. The
 * intent is retired so the same room can be captured again — the "abort that
 * and start a new one" flow.
 *
 * Contract: 200 { status: "stopped" | "not_recording" }.
 */
import { z } from "zod";
import type { IncomingMessage } from "node:http";

import { isLoopbackHost, isProxied } from "../request-auth.ts";
import { verifyActorAssertion } from "../relay-mcp.ts";
import { authorizeScribeJoiner, normalizeMeetingUrlKey } from "../scribe-intents.ts";
import { platformForUrl } from "../scribe-monitor.ts";
import type { BotRecord } from "../store.ts";
import { bearerCapabilityMatches, capabilityHash } from "./portal-session.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const SCRIBE_STOP_PATH = "/api/internal/scribe/stop";
const MAX_BODY_BYTES = 16 * 1024;

const bodySchema = z.object({
  instance_id: z.string().uuid().optional(),
  meeting_url: z.string().min(1).max(2048).optional(),
}).strict().refine((v) => v.instance_id !== undefined || v.meeting_url !== undefined, {
  message: "provide instance_id or meeting_url",
});

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

export interface LiveScribeIntent {
  instanceId: string;
  ownerUserId: string;
  urlKey: string;
  status: string;
}

export function createScribeStopRoutes(options: {
  store: { bot(id: string): Pick<BotRecord, "relayAgent" | "ownerUserId"> | null };
  capability: string | undefined;
  actorSecret: string | undefined;
  scribeReady: () => boolean;
  /** Live (pending or armed) intents the monitor might still arm. */
  listActive: () => LiveScribeIntent[];
  /** One intent by capture instance id. */
  getIntent: (instanceId: string) => LiveScribeIntent | null;
  /** Stop the worker's capture; resolves once the worker accepted the stop. */
  stopWorker: (instanceId: string) => Promise<{ status: string }>;
  /** Retire the intent so the room may be captured again. */
  retire: (instanceId: string) => void;
}): RouteHandler {
  const capabilityReady = typeof options.capability === "string" && Buffer.byteLength(options.capability) >= 32;
  const expectedHash = capabilityHash(options.capability ?? "");

  return async (ctx) => {
    if (ctx.path !== SCRIBE_STOP_PATH) return PASS;
    ctx.res.setHeader("cache-control", "no-store");

    if (
      isProxied(ctx.req) ||
      !isLoopbackHost(header(ctx.req.headers.host)) || !loopbackPeer(ctx.req)
    ) return reject(ctx, 403, { error: "forbidden" });

    if (ctx.method !== "POST") {
      ctx.res.setHeader("allow", "POST");
      return reject(ctx, 405, { error: "method not allowed" });
    }
    if (!/^application\/json\b/i.test(String(ctx.req.headers["content-type"] ?? ""))) {
      return reject(ctx, 415, { error: "send the request as JSON" });
    }
    if (!capabilityReady) return reject(ctx, 503, { error: "scribe stop service is unavailable" });
    if (!bearerCapabilityMatches(ctx.req, expectedHash)) return reject(ctx, 401, { error: "unauthorized" });

    let actor: { userId: string; botId: string; threadId: string; agent: "scout" | "mercury" | "curator" };
    try {
      actor = verifyActorAssertion(header(ctx.req.headers["x-relay-actor-user"]), options.actorSecret);
    } catch {
      return reject(ctx, 401, { error: "unauthorized" });
    }
    const authorized = authorizeScribeJoiner(actor, options.store);
    if (!authorized.ok) return reject(ctx, 403, { error: authorized.reason });

    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, MAX_BODY_BYTES);
    } catch {
      return reject(ctx, 400, { error: "invalid request body" });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return reject(ctx, 400, { error: "invalid stop request" });

    if (!options.scribeReady()) return reject(ctx, 503, { error: "scribe is not enabled" });

    // Match the actor's own live capture — by instance id if given, else by the
    // meeting's room key. Never another user's capture.
    let target: LiveScribeIntent | null = null;
    if (parsed.data.instance_id) {
      const intent = options.getIntent(parsed.data.instance_id);
      if (intent && intent.ownerUserId === actor.userId) target = intent;
    } else if (parsed.data.meeting_url) {
      const platform = platformForUrl(parsed.data.meeting_url);
      const urlKey = platform ? normalizeMeetingUrlKey(platform, parsed.data.meeting_url) : null;
      if (urlKey) {
        target = options.listActive().find((i) => i.urlKey === urlKey && i.ownerUserId === actor.userId) ?? null;
      }
    }

    if (!target || (target.status !== "pending" && target.status !== "armed")) {
      return ctx.json(ctx.res, 200, { status: "not_recording" });
    }

    try {
      const result = await options.stopWorker(target.instanceId);
      options.retire(target.instanceId);
      return ctx.json(ctx.res, 200, { status: "stopped", instance_id: target.instanceId, worker: result.status });
    } catch {
      return reject(ctx, 502, { error: "could not stop the capture" });
    }
  };
}
