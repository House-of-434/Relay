import { createHmac } from "node:crypto";
import { z } from "zod";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^relay\/[A-Za-z0-9._-]{1,100}$/;
const FILE_ID_PATTERN = /^file_[a-z0-9]{6,32}$/;

export const publishRequestSchema = z.object({
  repo: z.string().min(3).max(200).regex(REPO_PATTERN).refine((value) => !value.split("/").some((part) => part === "." || part === "..")),
  branch: z.string().min(1).max(120).regex(BRANCH_PATTERN).refine((value) => !value.split("/").includes("..")),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(24_000),
  path: z.string().min(1).max(512).refine((value) => value.startsWith("repos/") && !value.split("/").includes("..")),
  attachments: z.array(z.string().regex(FILE_ID_PATTERN)).max(12).default([]),
}).strict();

export type PublishRequestInput = z.infer<typeof publishRequestSchema>;

/** One reviewed screenshot or recording. The BFF resolves the file id to a
 * canonical path and binds the exact bytes; the broker revalidates before it
 * uploads anything. */
export interface PublishAttachment {
  fileId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  path: string;
}

export interface PublishAuthorization {
  version: 1;
  userId: string;
  botId: string;
  threadId: string;
  agent: "scout";
  repo: string;
  path: string;
  branch: string;
  commit: string;
  title: string;
  body: string;
  attachments: PublishAttachment[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

function signingBytes(value: Omit<PublishAuthorization, "signature">): string {
  return JSON.stringify([
    "relay-github-publish",
    value.version,
    value.userId,
    value.botId,
    value.threadId,
    value.agent,
    value.repo,
    value.path,
    value.branch,
    value.commit,
    value.title,
    value.body,
    value.attachments.map((attachment) => [
      attachment.fileId,
      attachment.name,
      attachment.mime,
      attachment.bytes,
      attachment.sha256,
      attachment.path,
    ]),
    value.nonce,
    value.issuedAt,
    value.expiresAt,
  ]);
}

export function signPublishAuthorization(
  value: Omit<PublishAuthorization, "version" | "signature">,
  secret: string | undefined,
): PublishAuthorization {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_TOOL_ACTOR_SECRET must contain at least 32 bytes");
  }
  const payload = { version: 1 as const, ...value };
  const signature = createHmac("sha256", secret).update(signingBytes(payload)).digest("base64url");
  return { ...payload, signature };
}

function brokerCapability(capability?: string): string | undefined {
  // The harness deletes RELAY_BFF_CAPABILITY from process.env at boot and
  // keeps it in memory. Callers pass that held value; the environment is only
  // a fallback for tests and non-harness callers.
  return capability ?? process.env.RELAY_BFF_CAPABILITY;
}

export function gitBrokerConfigured(capability?: string): boolean {
  const token = brokerCapability(capability);
  return Boolean(process.env.RELAY_GIT_BROKER_URL?.trim() && token && Buffer.byteLength(token) >= 32);
}

export async function gitBrokerSession(actorAssertion: string, workspace: string, capabilityInput?: string): Promise<{ token: string; url: string; expiresAt: number }> {
  const base = process.env.RELAY_GIT_BROKER_URL?.trim();
  const capability = brokerCapability(capabilityInput);
  if (!base || !capability) throw new Error("GitHub transport is not configured");
  let response: Response;
  try {
    response = await fetch(new URL("/internal/session", base), {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ actorAssertion, workspace }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("GitHub transport is unreachable");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : "GitHub transport refused the session");
  }
  const body = await response.json() as { token?: unknown; url?: unknown; expiresAt?: unknown };
  if (typeof body.token !== "string" || typeof body.url !== "string" || typeof body.expiresAt !== "number") {
    throw new Error("GitHub transport returned an invalid session");
  }
  return { token: body.token, url: body.url, expiresAt: body.expiresAt };
}

export async function publishToBroker(authorization: PublishAuthorization, sessionToken: string, capabilityInput?: string): Promise<{ prUrl: string; branch: string; commit: string; updated: boolean }> {
  const base = process.env.RELAY_GIT_BROKER_URL?.trim();
  const capability = brokerCapability(capabilityInput);
  if (!base || !capability) throw new Error("GitHub publishing is not configured");
  let response: Response;
  try {
    response = await fetch(new URL("/internal/publish", base), {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ ...authorization, sessionToken }),
      signal: AbortSignal.timeout(6 * 60_000),
    });
  } catch {
    throw new Error("GitHub publishing is unreachable");
  }
  const body = await response.json().catch(() => ({})) as { error?: unknown; prUrl?: unknown; branch?: unknown; commit?: unknown; updated?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "GitHub refused the publish");
  if (typeof body.prUrl !== "string" || typeof body.branch !== "string" || typeof body.commit !== "string") {
    throw new Error("GitHub publishing returned an invalid result");
  }
  return { prUrl: body.prUrl, branch: body.branch, commit: body.commit, updated: body.updated === true };
}
