/** Browser-takeover card creation, BFF leg.
 *
 * The Tool Layer cannot reach the harness directly (the harness edge gate
 * requires a loopback Host). This route terminates the tool-facing auth —
 * the shared BFF capability plus the original signed actor assertion — and
 * proxies the request to the harness over loopback, where both are verified
 * again. It derives nothing and decides nothing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { verifyActorAssertion } from "./actor-assertion.ts";

export const INTERNAL_BROWSER_TAKEOVER = "/api/internal/browser-takeover/request";

const MAX_BODY_BYTES = 16 * 1024;

const requestSchema = z.object({
  request_key: z.string().uuid(),
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(600),
  expires_at: z.string().datetime(),
}).strict();

export interface InternalBrowserTakeoverOptions {
  capability: string;
  actorSecret: string | undefined;
  harnessBase: URL;
  harnessCapability: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function isInternalBrowserTakeoverPath(pathname: string): boolean {
  return pathname === INTERNAL_BROWSER_TAKEOVER;
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

export async function handleInternalBrowserTakeover(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalBrowserTakeoverOptions,
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
  const parsed = requestSchema.safeParse(raw);
  if (pathname !== INTERNAL_BROWSER_TAKEOVER || !parsed.success) {
    json(res, pathname === INTERNAL_BROWSER_TAKEOVER ? 400 : 404, {
      error: pathname === INTERNAL_BROWSER_TAKEOVER ? "invalid browser takeover request" : "not found",
    });
    return;
  }

  const fetcher = options.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(new URL("/api/internal/browser-takeover", options.harnessBase), {
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
    json(res, 502, { error: "browser takeover request failed" });
    return;
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    json(res, 502, { error: "browser takeover request failed" });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 502, { error: "browser takeover request failed" });
    return;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.message_id === "string") {
    json(res, upstream.status, { message_id: record.message_id });
    return;
  }
  if (typeof record.error === "string" && record.error.length > 0 && record.error.length <= 200) {
    json(res, upstream.status, { error: record.error });
    return;
  }
  json(res, 502, { error: "browser takeover request failed" });
}
