import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { verifyActorAssertion } from "./actor-assertion.ts";

export const INTERNAL_SCRIBE_STOP = "/api/internal/scribe/stop";

const MAX_BODY_BYTES = 16 * 1024;

const stopSchema = z.object({
  instance_id: z.string().uuid().optional(),
  meeting_url: z.string().min(1).max(2048).optional(),
}).strict().refine((v) => v.instance_id !== undefined || v.meeting_url !== undefined, {
  message: "provide instance_id or meeting_url",
});

export interface InternalScribeStopOptions {
  capability: string;
  actorSecret: string | undefined;
  harnessBase: URL;
  harnessCapability: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function isInternalScribeStopPath(pathname: string): boolean {
  return pathname === INTERNAL_SCRIBE_STOP;
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
 * Manual Scribe stop, BFF leg — the same authenticated proxy as the join leg:
 * the tool layer cannot reach the loopback-gated harness directly, so the BFF
 * verifies the shared capability and the original actor assertion, then
 * forwards the untouched request. The harness re-verifies and decides.
 */
export async function handleInternalScribeStop(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalScribeStopOptions,
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
  const parsed = stopSchema.safeParse(raw);
  if (pathname !== INTERNAL_SCRIBE_STOP || !parsed.success) {
    json(res, pathname === INTERNAL_SCRIBE_STOP ? 400 : 404, {
      error: pathname === INTERNAL_SCRIBE_STOP ? "invalid stop request" : "not found",
    });
    return;
  }

  const fetcher = options.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(new URL(INTERNAL_SCRIBE_STOP, options.harnessBase), {
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
    json(res, 502, { error: "stop request failed" });
    return;
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    json(res, 502, { error: "stop request failed" });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 502, { error: "stop request failed" });
    return;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.status !== "string") {
    if (typeof record.error === "string" && record.error.length > 0 && record.error.length <= 200) {
      json(res, upstream.status, { error: record.error });
      return;
    }
    json(res, 502, { error: "stop request failed" });
    return;
  }
  json(res, upstream.status, {
    status: record.status,
    ...(typeof record.instance_id === "string" ? { instance_id: record.instance_id } : {}),
  });
}
