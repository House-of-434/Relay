import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { WorkerConfig } from "./config.js";
import type { JoinController, JoinDescriptor } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
}

function capabilityMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function asDescriptor(raw: unknown): JoinDescriptor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("descriptor must be an object");
  const d = raw as Record<string, unknown>;
  if (typeof d.instance_id !== "string" || d.instance_id.length === 0) throw new Error("descriptor requires instance_id");
  if (typeof d.platform !== "string" || !["google_meet", "zoom", "teams"].includes(d.platform)) throw new Error("descriptor requires a known platform");
  if (typeof d.meeting_url !== "string" || d.meeting_url.length === 0) throw new Error("descriptor requires meeting_url");
  return d as unknown as JoinDescriptor;
}

/** The worker endpoint: capability-authed, no loopback requirement (the
 * capability is the boundary). POST /join is idempotent by instance_id. */
export function createScribeWorkerServer(controller: JoinController, config: WorkerConfig) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { app: "relay-scribe", status: "ok", enabled: config.enabled });
        return;
      }
      if (req.method !== "POST" || !["/join", "/status", "/stop"].includes(url.pathname)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (!capabilityMatches(bearer(req), config.workerCapability)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (!/^application\/json\b/i.test(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "")) {
        sendJson(res, 415, { error: "send the request as JSON" });
        return;
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid body" });
        return;
      }
      try {
        if (url.pathname === "/join") {
          if (!config.enabled) {
            sendJson(res, 200, { instance_id: (body as { instance_id?: string })?.instance_id ?? "", status: "failed", error: "scribe is disabled" });
            return;
          }
          const descriptor = asDescriptor(body);
          sendJson(res, 200, await controller.join(descriptor));
          return;
        }
        const instanceId = (body as { instance_id?: unknown })?.instance_id;
        if (typeof instanceId !== "string" || instanceId.length === 0) {
          sendJson(res, 400, { error: "instance_id is required" });
          return;
        }
        sendJson(res, 200, url.pathname === "/status" ? await controller.status(instanceId) : await controller.stop(instanceId));
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "bad request" });
      }
    })();
  });
}
