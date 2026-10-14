import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { verifyActorAssertion } from "./actor-assertion.ts";

export const INTERNAL_SCRIBE_JOIN = "/api/internal/scribe/join";

const MAX_BODY_BYTES = 16 * 1024;

const joinSchema = z.object({
  request_key: z.string().uuid(),
  meeting_url: z.string().min(1).max(2048),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

export interface InternalScribeJoinOptions {
  capability: string;
  actorSecret: string | undefined;
  /** Loopback harness origin (the BFF and harness share a container; the
   * harness hardcodes 127.0.0.1). The harness re-verifies both the
   * capability and the actor assertion on arrival. */
  harnessBase: URL;
  /** Bearer the harness accepts: the same shared BFF capability. No new
   * secret is introduced for this hop. */
  harnessCapability: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function isInternalScribeJoinPath(pathname: string): boolean {
  return pathname === INTERNAL_SCRIBE_JOIN;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function capabilityMatches(req: IncomingMessage, expectedHash: Buffer): boolean {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
  if (!match || Buffer.byteLength(match[1]!) > 4096) return false;
  return timingSafeEqual(hash(match[1]!), expectedHash);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Manual Scribe join, BFF leg. The tool layer cannot call the harness
 * directly: the harness edge gate requires a loopback Host, and compose
 * callers address it by container name. The BFF therefore terminates the
 * tool-facing authentication (shared capability plus verified actor
 * assertion, exactly like the Gmail/Calendar routes) and proxies the
 * untouched request — same body, same original assertion — to the harness
 * over loopback, where the harness verifies both again and authorizes the
 * Mercury-scoped action. The BFF derives nothing and decides nothing here;
 * it is an authenticated proxy, not a second authorizer.
 *
 * The boundary is the shared capability plus the signed actor assertion,
 * not the peer's address: in the compose deployment the Tool Layer is a
 * separate container and is never a loopback peer.
 */
export async function handleInternalScribeJoin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalScribeJoinOptions,
): Promise<void> {
  const expectedHash = hash(options.capability);
  req.resume();
  if (!capabilityMatches(req, expectedHash)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (!/^application\/json\b/i.test(headerString(req.headers["content-type"]) ?? "")) {
    json(res, 415, { error: "send the request as JSON" });
    return;
  }

  // Forward the ORIGINAL assertion string, not a re-signed copy: the
  // harness verifies the same signature bytes it would see on any other
  // route, preserving issuedAt/skew semantics end to end.
  const assertion = headerString(req.headers["x-relay-actor-user"]);
  try {
    verifyActorAssertion(assertion, options.actorSecret, options.now?.() ?? Date.now());
  } catch {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    json(res, 400, { error: "invalid request body" });
    return;
  }
  const parsed = joinSchema.safeParse(raw);
  if (pathname !== INTERNAL_SCRIBE_JOIN || !parsed.success) {
    json(res, pathname === INTERNAL_SCRIBE_JOIN ? 400 : 404, {
      error: pathname === INTERNAL_SCRIBE_JOIN ? "invalid join request" : "not found",
    });
    return;
  }

  const fetcher = options.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(new URL(INTERNAL_SCRIBE_JOIN, options.harnessBase), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.harnessCapability}`,
        "x-relay-actor-user": assertion!,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed.data),
    });
  } catch {
    json(res, 502, { error: "capture request failed" });
    return;
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    json(res, 502, { error: "capture request failed" });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 502, { error: "capture request failed" });
    return;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.status !== "string" || typeof record.instance_id !== "string") {
    if (typeof record.error === "string" && record.error.length > 0 && record.error.length <= 200) {
      json(res, upstream.status, { error: record.error });
      return;
    }
    json(res, 502, { error: "capture request failed" });
    return;
  }
  json(res, upstream.status, { status: record.status, instance_id: record.instance_id });
}
