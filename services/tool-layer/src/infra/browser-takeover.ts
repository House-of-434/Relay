/** Tool Layer -> BFF client for browser-takeover card creation.
 *
 * The harness persists the card, so the Tool Layer cannot do it directly:
 * the harness edge gate requires a loopback Host, and a compose caller
 * addresses it by container name. The BFF terminates this hop with the same
 * dual auth as the Scribe join route (shared capability + the original actor
 * assertion) and proxies to the harness, which re-verifies both.
 */
import { createHash } from "node:crypto";

export const BROWSER_TAKEOVER_INTERNAL_PATH = "/api/internal/browser-takeover/request";

/** Deterministic idempotency key: one card per (user, session, generation),
 * so a retried tool call reuses the pending card instead of stacking another
 * intervention and another browser session. */
export function takeoverRequestKey(userId: string, sessionId: string, generation: number): string {
  const h = createHash("sha256").update(`browser-takeover:${userId}:${sessionId}:${generation}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface BrowserTakeoverCardInput {
  requestKey: string;
  sessionId: string;
  generation: number;
  title: string;
  description: string;
  expiresAt: string;
}

export interface BrowserTakeoverCardResult {
  messageId: string;
}

export class BrowserTakeoverRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BrowserTakeoverRequestError";
    this.status = status;
  }
}

export class RelayBrowserTakeoverClient {
  private readonly bffInternalUrl: string;
  private readonly capability: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: { bffInternalUrl: string; capability: string | undefined; fetcher?: typeof fetch }) {
    this.bffInternalUrl = options.bffInternalUrl.replace(/\/+$/, "");
    this.capability = options.capability;
    this.fetcher = options.fetcher ?? fetch;
  }

  async requestCard(actorAssertion: string, input: BrowserTakeoverCardInput): Promise<BrowserTakeoverCardResult> {
    if (typeof this.capability !== "string" || Buffer.byteLength(this.capability) < 32) {
      throw new BrowserTakeoverRequestError(503, "the login browser card service is not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(BROWSER_TAKEOVER_INTERNAL_PATH, this.bffInternalUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.capability}`,
          "x-relay-actor-user": actorAssertion,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request_key: input.requestKey,
          session_id: input.sessionId,
          generation: input.generation,
          title: input.title,
          description: input.description,
          expires_at: input.expiresAt,
        }),
      });
    } catch {
      throw new BrowserTakeoverRequestError(502, "the login browser card service is unreachable");
    }
    if (!response.ok) {
      throw new BrowserTakeoverRequestError(response.status, await safeErrorMessage(response));
    }
    const body = (await response.json().catch(() => null)) as { message_id?: unknown } | null;
    if (!body || typeof body.message_id !== "string") {
      throw new BrowserTakeoverRequestError(502, "the login browser card service answered unexpectedly");
    }
    return { messageId: body.message_id };
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error.slice(0, 200);
  } catch {
    /* fall through */
  }
  return `the login browser card service returned ${response.status}`;
}
