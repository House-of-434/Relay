/** Manual Scribe join route: Mercury asks the harness to capture a meeting now.
 *
 * POST /api/internal/scribe/join — capability-authed with NO loopback
 * requirement (the shared capability is the boundary: the legitimate caller,
 * the tool layer, reaches the harness over the compose network, same as the
 * capture worker's own endpoint). Dual auth, mirroring the BFF internal
 * routes: Bearer RELAY_BFF_CAPABILITY plus the verified per-turn actor
 * assertion. The actor must be a Mercury bot in its owner's workspace;
 * organizer identity derives server-side from that actor, never from the
 * request body.
 *
 * Contract: acceptance registers a durable intent (the monitor arms it);
 * acceptance is NOT execution. 202 accepted (fresh instance), 200
 * already_accepted (same request retried, or the room is already being
 * captured), 400/401/403 rejected, 503 unavailable.
 */
import { z } from "zod";
import type { IncomingMessage } from "node:http";

import { isLoopbackHost, isProxied } from "../request-auth.ts";
import { verifyActorAssertion } from "../relay-mcp.ts";
import { acceptManualJoin, authorizeScribeJoiner } from "../scribe-intents.ts";
import { platformForUrl } from "../scribe-monitor.ts";
import type { BotRecord } from "../store.ts";
import { threadOwner } from "../thread-owners.ts";
import { bearerCapabilityMatches, capabilityHash } from "./portal-session.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const SCRIBE_JOIN_PATH = "/api/internal/scribe/join";
const MAX_BODY_BYTES = 16 * 1024;

const bodySchema = z.object({
  /** Idempotency key for the user intent. Required: retries without a stable
   * key cannot deduplicate, so keyless requests are rejected, not guessed. */
  request_key: z.string().uuid(),
  meeting_url: z.string().min(1).max(2048),
  /** Untrusted display metadata only: trimmed, bounded, never identity. */
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isLoopbackHost(normalized);
}

/** Answer a rejection. Rejections never consume the request body, so the
 * connection is closed: leftover body bytes would otherwise be re-parsed as
 * a new request and desync keep-alive reuse (bare-400 + poisoned socket).
 * Acceptances read the full body via readBody and keep the connection. */
function reject(ctx: RouteContext, status: number, body: unknown): void {
  ctx.res.setHeader("connection", "close");
  ctx.json(ctx.res, status, body);
}

export function createScribeJoinRoutes(options: {
  store: { bot(id: string): Pick<BotRecord, "relayAgent" | "ownerUserId"> | null };
  dataDir: string;
  capability: string | undefined;
  actorSecret: string | undefined;
  /** False when Scribe is disabled or the worker capability is missing: the
   * monitor that would drain the intent does not exist. */
  scribeReady: () => boolean;
}): RouteHandler {
  const capabilityReady = typeof options.capability === "string" && Buffer.byteLength(options.capability) >= 32;
  const expectedHash = capabilityHash(options.capability ?? "");

  return async (ctx) => {
    if (ctx.path !== SCRIBE_JOIN_PATH) return PASS;
    ctx.res.setHeader("cache-control", "no-store");

    // Loopback-only, like the portal bridge: the sole legitimate caller is
    // the BFF in this container, reaching the harness at 127.0.0.1. Compose
    // callers (tool layer) address the harness by container name and must go
    // through the BFF route instead — the harness edge gate already rejects
    // those with a loopback-host error before this handler ever runs.
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
    if (!capabilityReady) return reject(ctx, 503, { error: "scribe join service is unavailable" });
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
    if (!parsed.success) return reject(ctx, 400, { error: "invalid join request" });

    const platform = platformForUrl(parsed.data.meeting_url);
    if (!platform) return reject(ctx, 400, { error: "meeting host is not a supported provider" });

    if (!options.scribeReady()) return reject(ctx, 503, { error: "scribe is not enabled" });

    // Requester email comes from the thread-owner record stamped for the
    // ASSERTED thread, cross-checked against the asserted user — never from
    // the request body, which carries no identity fields at all.
    const owner = threadOwner(options.dataDir, actor.threadId);
    const organizerEmail = owner?.userId === actor.userId ? owner.email : undefined;

    try {
      const { outcome, intent } = acceptManualJoin({
        requestKey: parsed.data.request_key,
        meetingUrl: parsed.data.meeting_url,
        platform,
        title: parsed.data.title,
        organizerEmail,
        actor,
      });
      if (outcome === "created") {
        return ctx.json(ctx.res, 202, { status: "accepted", instance_id: intent.instanceId });
      }
      return ctx.json(ctx.res, 200, { status: "already_accepted", instance_id: intent.instanceId });
    } catch {
      return reject(ctx, 400, { error: "invalid join request" });
    }
  };
}
