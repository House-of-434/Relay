/** Tool Layer -> BFF client for browser-takeover card creation.
 *
 * The harness persists the card, so the Tool Layer cannot do it directly:
 * the harness edge gate requires a loopback Host, and a compose caller
 * addresses it by container name. The BFF terminates this hop with the same
 * dual auth as the Scribe join route (shared capability + the original actor
 * assertion) and proxies to the harness, which re-verifies both.
 */
export const BROWSER_TAKEOVER_INTERNAL_PATH = "/api/internal/browser-takeover/request";

export interface BrowserTakeoverCardInput {
  sessionId: string;
  generation: number;
  title: string;
  expiresAt: string;
  /** One-shot PNG/JPEG data URL of the page the person is taking over. */
  screenshot?: string;
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
      throw new BrowserTakeoverRequestError(503, "the browser takeover card service is not configured");
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
          session_id: input.sessionId,
          generation: input.generation,
          title: input.title,
          expires_at: input.expiresAt,
          ...(input.screenshot ? { screenshot: input.screenshot } : {}),
        }),
      });
    } catch {
      throw new BrowserTakeoverRequestError(502, "the browser takeover card service is unreachable");
    }
    if (!response.ok) {
      throw new BrowserTakeoverRequestError(response.status, await safeErrorMessage(response));
    }
    const body = (await response.json().catch(() => null)) as { message_id?: unknown } | null;
    if (!body || typeof body.message_id !== "string") {
      throw new BrowserTakeoverRequestError(502, "the browser takeover card service answered unexpectedly");
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
  return `the browser takeover card service returned ${response.status}`;
}
