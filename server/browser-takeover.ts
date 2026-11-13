/** Harness -> Tool Layer client for the browser-takeover control plane.
 *
 * The harness owns the card and the resume; the Tool Layer owns the browser
 * session, display, and viewer tokens. Both calls carry a freshly signed
 * actor assertion (the same scheme the MCP route uses), and the Tool Layer
 * re-checks that the session belongs to that user.
 */
import { signedActorContext } from "./relay-mcp.ts";
import type { RelayAgentRole } from "../packages/relay-shared/relay-agent.ts";
import type { TakeoverCardData, WireMessage } from "../shared/wire.ts";

/** The card window. Once it passes the card is terminal: release the browser
 * and stop the task. A new request is needed to try again. */
export const BROWSER_TAKEOVER_TTL_MS = 10 * 60_000;

/** The latest browser-takeover card in a thread, when it is settled back to
 * the agent (`done`) rather than waiting on the person. A newer pending card
 * reuses the same tool-layer session, so an older done card must not release
 * it. */
export function latestSettledTakeover(
  messages: ReadonlyArray<Pick<WireMessage, "id" | "kind" | "takeover">>,
): { messageId: string; card: TakeoverCardData } | null {
  const message = messages.findLast((candidate) => candidate.kind === "takeover" && candidate.takeover);
  const card = message?.takeover;
  if (!message || !card || card.status !== "done") return null;
  return { messageId: message.id, card };
}

export interface TakeoverActor {
  userId: string;
  botId: string;
  threadId: string;
  agent: RelayAgentRole;
  /** The provider turn generation that owns this browser session. */
  turnId?: string;
}

export class ToolLayerTakeoverError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ToolLayerTakeoverError";
    this.status = status;
  }
}

export class ToolLayerTakeoverClient {
  private readonly toolUrl: string | undefined;
  private readonly actorSecret: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: { toolUrl: string | undefined; actorSecret: string | undefined; fetcher?: typeof fetch }) {
    this.toolUrl = options.toolUrl;
    this.actorSecret = options.actorSecret;
    this.fetcher = options.fetcher ?? fetch;
  }

  private assertion(actor: TakeoverActor): string {
    if (!this.toolUrl) throw new ToolLayerTakeoverError(503, "the login browser is not configured");
    return signedActorContext(actor, this.actorSecret);
  }

  async viewer(actor: TakeoverActor, sessionId: string, generation: number): Promise<{ path: string; local: boolean }> {
    const body = await this.post(actor, "/internal/browser-takeover/viewer", { session_id: sessionId, generation });
    const local = body.local === true;
    const path = typeof body.path === "string" ? body.path : "";
    if (local ? path !== "" : !path.startsWith("/_viewer/")) {
      throw new ToolLayerTakeoverError(502, "the live browser answered unexpectedly");
    }
    return { path, local };
  }

  async handBack(actor: TakeoverActor, sessionId: string, generation: number): Promise<{ handedBack: boolean }> {
    const body = await this.post(actor, "/internal/browser-takeover/handback", { session_id: sessionId, generation });
    return { handedBack: body.handed_back === true };
  }

  async release(actor: TakeoverActor, sessionId: string, generation: number): Promise<boolean> {
    const body = await this.post(actor, "/internal/browser-takeover/release", { session_id: sessionId, generation });
    return body.released === true;
  }

  /** Turn-end close: the signed turnId selects the exact session. A delayed
   * request for an older turn closes nothing. */
  async closeSession(actor: TakeoverActor): Promise<boolean> {
    const body = await this.post(actor, "/internal/browser-session/close", {});
    return body.closed === true;
  }

  private async post(actor: TakeoverActor, path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const assertion = this.assertion(actor);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.toolUrl), {
        method: "POST",
        redirect: "error",
        headers: { "x-relay-actor-user": assertion, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ToolLayerTakeoverError(502, "the live browser is unreachable");
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const error = body && typeof body.error === "string" ? body.error : `the live browser returned ${response.status}`;
      throw new ToolLayerTakeoverError(response.status, error.slice(0, 200));
    }
    return body ?? {};
  }
}
