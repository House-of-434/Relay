import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";

import { isLoopbackHost, isProxied } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ISSUE_PATH = "/api/internal/portal-session";
const REVOKE_PATH = `${ISSUE_PATH}/revoke`;
const MAX_BODY_BYTES = 16 * 1024;
const scopeSchema = z.enum(["admin", "client"]);
const issueSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().max(320),
  scopes: z.array(scopeSchema).min(1).max(2),
}).strict();
const revokeSchema = z.union([
  z.object({ token: z.string().regex(/^relay_sess_[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ sessionId: z.string().uuid() }).strict(),
]);

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isLoopbackHost(normalized);
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerCapabilityMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
  const authorization = header(req.headers.authorization);
  const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (!match || Buffer.byteLength(match[1]!) > 4096) return false;
  return timingSafeEqual(hash(match[1]!), expectedHash);
}

function requestStatus(error: unknown): 400 | 413 {
  const status = error && typeof error === "object" && "status" in error ? Reflect.get(error, "status") : undefined;
  return status === 413 ? 413 : 400;
}

/** The internal BFF bridge. Both issuance and revocation require the hosted
 * workspace's service-trust loopback and its dedicated shared capability. */
export function createPortalSessionRoutes(options: {
  sessions: SessionRegistry;
  capability: string | undefined;
  sharedWorkspace: () => boolean;
  environment: () => unknown;
}): RouteHandler {
  const capabilityReady = typeof options.capability === "string" && Buffer.byteLength(options.capability) >= 32;
  const expectedHash = hash(options.capability ?? "");

  return async (ctx) => {
    if (![ISSUE_PATH, REVOKE_PATH].includes(ctx.path)) return PASS;
    ctx.res.setHeader("cache-control", "no-store");

    if (!options.sharedWorkspace()) return ctx.json(ctx.res, 404, { error: "not found" });
    if (
      ctx.auth.kind !== "loopback" || isProxied(ctx.req) ||
      !isLoopbackHost(header(ctx.req.headers.host)) || !loopbackPeer(ctx.req)
    ) return ctx.json(ctx.res, 403, { error: "forbidden" });
    if (!capabilityReady) return ctx.json(ctx.res, 503, { error: "internal session service is unavailable" });
    if (!bearerCapabilityMatches(ctx.req, expectedHash)) return ctx.json(ctx.res, 401, { error: "unauthorized" });

    if (ctx.method !== "POST") {
      ctx.res.setHeader("allow", "POST");
      return ctx.json(ctx.res, 405, { error: "method not allowed" });
    }
    if (!/^application\/json\b/i.test(String(ctx.req.headers["content-type"] ?? ""))) {
      return ctx.json(ctx.res, 415, { error: "send the request as JSON" });
    }

    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, MAX_BODY_BYTES);
    } catch (error) {
      return ctx.json(ctx.res, requestStatus(error), { error: "invalid request body" });
    }

    if (ctx.path === ISSUE_PATH) {
      const parsed = issueSchema.safeParse(raw);
      if (!parsed.success) return ctx.json(ctx.res, 400, { error: "invalid session identity" });
      const issued = options.sessions.issuePortal(parsed.data);
      return ctx.json(ctx.res, 200, {
        token: issued.token,
        session: issued.session,
        environment: options.environment(),
      });
    }

    const parsed = revokeSchema.safeParse(raw);
    if (!parsed.success) return ctx.json(ctx.res, 400, { error: "invalid session revocation" });
    const revoked = "token" in parsed.data
      ? options.sessions.revokePortalToken(parsed.data.token)
      : options.sessions.revokePortal(parsed.data.sessionId);
    return ctx.json(ctx.res, 200, { ok: true, revoked });
  };
}
