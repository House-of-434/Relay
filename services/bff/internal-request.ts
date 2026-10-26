import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { verifyActorAssertion, type RelayActor } from "./actor-assertion.ts";

/** The one verifier every internal service-to-service route runs first.
 *
 * Internal routes are reached by the Tool Layer across the compose network,
 * where the peer address proves nothing. The boundary is the shared capability
 * plus the signed actor assertion (which now carries the calling agent). Doing
 * this in one place — instead of once per module — is what makes the guarantee
 * "every internal request verifies the actor" hold without exception. */

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface InternalRequestOptions {
  /** Shared BFF capability secret (RELAY_BFF_CAPABILITY). */
  capability: string;
  /** HMAC secret for the actor assertion (RELAY_TOOL_ACTOR_SECRET). */
  actorSecret: string | undefined;
  now?: () => number;
  maxBodyBytes?: number;
}

export interface VerifiedInternalRequest {
  actor: RelayActor;
  body: unknown;
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerMatches(value: string | undefined, expectedHash: Buffer): boolean {
  const match = value ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  if (!match || Buffer.byteLength(match[1]!) > 4096) return false;
  return timingSafeEqual(hash(match[1]!), expectedHash);
}

function capabilityMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
  const authorization = req.headers.authorization;
  return bearerMatches(typeof authorization === "string" ? authorization : undefined, expectedHash);
}

/** A second, route-specific capability carried on its own header. Used where a
 * shared BFF capability is not enough to separate the caller (the Harness's
 * trusted mailbox replies from the agent-facing send route). */
export function requestHasCapability(
  req: IncomingMessage,
  headerName: string,
  expected: string | undefined,
): boolean {
  if (typeof expected !== "string" || Buffer.byteLength(expected) < 32) return false;
  const value = req.headers[headerName.toLowerCase()];
  return bearerMatches(typeof value === "string" ? value : undefined, hash(expected));
}

async function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Validate an internal request end to end. On any failure the response is
 * written here and `undefined` is returned, so a handler cannot accidentally
 * continue past a failed check. On success the verified actor and parsed body
 * are returned.
 */
export async function verifyInternalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalRequestOptions,
  expectedPath: string,
): Promise<VerifiedInternalRequest | undefined> {
  // Drain so the socket is reusable even when the request is refused.
  req.resume();
  if (pathname !== expectedPath) {
    jsonResponse(res, 404, { error: "not found" });
    return undefined;
  }
  if (!capabilityMatches(req, hash(options.capability))) {
    jsonResponse(res, 401, { error: "unauthorized" });
    return undefined;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    jsonResponse(res, 405, { error: "method not allowed" });
    return undefined;
  }
  if (!/^application\/json\b/i.test(headerString(req.headers["content-type"]) ?? "")) {
    jsonResponse(res, 415, { error: "send the request as JSON" });
    return undefined;
  }

  let actor: RelayActor;
  try {
    actor = verifyActorAssertion(
      headerString(req.headers["x-relay-actor-user"]),
      options.actorSecret,
      options.now?.() ?? Date.now(),
    );
  } catch {
    jsonResponse(res, 401, { error: "unauthorized" });
    return undefined;
  }

  let body: unknown;
  try {
    body = await readJson(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  } catch {
    jsonResponse(res, 400, { error: "invalid request body" });
    return undefined;
  }

  return { actor, body };
}
