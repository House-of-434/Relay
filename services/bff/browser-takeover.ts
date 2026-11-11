/** Browser-takeover card creation, BFF leg.
 *
 * The Tool Layer cannot reach the harness directly (the harness edge gate
 * requires a loopback Host). This route terminates the tool-facing auth —
 * the shared BFF capability plus the original signed actor assertion — and
 * proxies the request to the harness over loopback, where both are verified
 * again. It derives nothing and decides nothing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { browserTakeoverCardSchema } from "../../shared/takeover-wire.ts";
import { jsonResponse, verifyInternalRequest } from "./internal-request.ts";

export const INTERNAL_BROWSER_TAKEOVER = "/api/internal/browser-takeover/request";

// One screenshot data URL (~1.5 MB decoded) rides with the card metadata.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

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

export async function handleInternalBrowserTakeover(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: InternalBrowserTakeoverOptions,
): Promise<void> {
  const verified = await verifyInternalRequest(
    req,
    res,
    pathname,
    {
      capability: options.capability,
      actorSecret: options.actorSecret,
      ...(options.now ? { now: options.now } : {}),
      maxBodyBytes: MAX_BODY_BYTES,
    },
    INTERNAL_BROWSER_TAKEOVER,
  );
  if (!verified) return;

  const parsed = browserTakeoverCardSchema.safeParse(verified.body);
  if (!parsed.success) {
    jsonResponse(res, 400, { error: "invalid browser takeover request" });
    return;
  }

  const assertion = req.headers["x-relay-actor-user"];
  const fetcher = options.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(new URL("/api/internal/browser-takeover", options.harnessBase), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.harnessCapability}`,
        "x-relay-actor-user": typeof assertion === "string" ? assertion : "",
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed.data),
    });
  } catch {
    jsonResponse(res, 502, { error: "browser takeover request failed" });
    return;
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    jsonResponse(res, 502, { error: "browser takeover request failed" });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    jsonResponse(res, 502, { error: "browser takeover request failed" });
    return;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.message_id === "string") {
    jsonResponse(res, upstream.status, { message_id: record.message_id });
    return;
  }
  if (typeof record.error === "string" && record.error.length > 0 && record.error.length <= 200) {
    jsonResponse(res, upstream.status, { error: record.error });
    return;
  }
  jsonResponse(res, 502, { error: "browser takeover request failed" });
}
