/** Browser-takeover card lifecycle.
 *
 * Owns the card state machine, expiry timers, bounded release retries, the
 * one-shot screenshot store, and release-after-turn. The store, the tool-layer
 * client, and the clock are injected so the state machine is unit-testable
 * without booting the harness.
 *
 * Product rules encoded here:
 * - A card expires after one fixed TTL. A failed release retries with bounded
 *   backoff and never extends `expiresAt`.
 * - Only Done resumes the agent. Dismiss and expiry settle the card and stop
 *   the task; the person's next message is a normal turn.
 * - A message while the card is pending is the hand-back (handled by the
 *   caller); this module only performs the terminal transition.
 */
import {
  BROWSER_TAKEOVER_TTL_MS,
  ToolLayerTakeoverError,
  type TakeoverActor,
  type ToolLayerTakeoverClient,
} from "./browser-takeover.ts";
import { takeoverPending } from "../shared/takeover-card.ts";
import type { TakeoverCardData } from "../shared/wire.ts";

/** 4 retries after the first failure: 5s, 15s, 60s, 5m. */
export const TAKEOVER_RELEASE_RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;

export interface TakeoverCardRecord {
  messageId: string;
  botId: string;
  card: TakeoverCardData;
}

export interface TakeoverLifecycleDeps {
  now?: () => number;
  screenshotTtlMs?: number;
  getCard(botId: string, threadId: string, messageId: string): TakeoverCardData | null;
  patchCard(threadId: string, messageId: string, card: TakeoverCardData): void;
  pendingCards(threadId: string): TakeoverCardRecord[];
  latestSettled(threadId: string): TakeoverCardRecord | null;
  actorFor(botId: string, threadId: string): TakeoverActor;
  client: Pick<ToolLayerTakeoverClient, "handBack" | "release">;
  resume(botId: string, threadId: string, messageId: string, note?: string): void;
  markResumeInFlight(threadId: string, messageId: string): void;
  isResumeQueued(threadId: string, messageId: string): boolean;
  consumeResumeInFlight(threadId: string, messageId: string): boolean;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface TerminalTakeoverResult {
  status: string;
  resumed: boolean;
  changed: boolean;
}

export class TakeoverLifecycle {
  private readonly now: () => number;
  private readonly screenshotTtlMs: number;
  private readonly deps: TakeoverLifecycleDeps;
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly terminalizing = new Map<string, Promise<TerminalTakeoverResult>>();
  private readonly screenshots = new Map<
    string,
    { dataUrl: string; sessionId: string; generation: number; at: number }
  >();

  constructor(deps: TakeoverLifecycleDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.screenshotTtlMs = deps.screenshotTtlMs ?? BROWSER_TAKEOVER_TTL_MS + 60_000;
  }

  private log(level: "info" | "warn", message: string): void {
    (this.deps.logger ?? console)[level](message);
  }

  private key(threadId: string, messageId: string): string {
    return `${threadId}:${messageId}`;
  }

  rememberScreenshot(messageId: string, dataUrl: string, sessionId: string, generation: number): void {
    const cutoff = this.now() - this.screenshotTtlMs;
    for (const [key, value] of this.screenshots) {
      if (value.at < cutoff) this.screenshots.delete(key);
    }
    this.screenshots.set(messageId, { dataUrl, sessionId, generation, at: this.now() });
  }

  screenshot(messageId: string): string | null {
    return this.screenshots.get(messageId)?.dataUrl ?? null;
  }

  clearScreenshot(messageId: string): void {
    this.screenshots.delete(messageId);
  }

  clearTimer(threadId: string, messageId: string): void {
    const key = this.key(threadId, messageId);
    const timer = this.expiryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(key);
    const retry = this.retryTimers.get(key);
    if (retry) clearTimeout(retry);
    this.retryTimers.delete(key);
    this.retryAttempts.delete(key);
  }

  /** Schedule the card's fixed TTL. A restart re-arms every pending card from
   * its stored `expiresAt`; the timestamp itself is never mutated. */
  scheduleExpiry(botId: string, threadId: string, messageId: string): void {
    this.clearTimer(threadId, messageId);
    const card = this.deps.getCard(botId, threadId, messageId);
    if (!card || !takeoverPending(card)) return;
    const due = Date.parse(card.expiresAt);
    const delay = Number.isFinite(due) ? Math.max(0, due - this.now()) : 0;
    const timer = setTimeout(() => {
      this.expiryTimers.delete(this.key(threadId, messageId));
      void this.terminal(botId, threadId, messageId, "expired").catch(() => {});
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    this.expiryTimers.set(this.key(threadId, messageId), timer);
  }

  /** One live card per bot in a conversation. Older sessions are released
   * without resuming their agent turn. */
  supersede(botId: string, threadId: string, keepMessageId: string): void {
    for (const record of this.deps.pendingCards(threadId)) {
      if (record.botId !== botId || record.messageId === keepMessageId) continue;
      void this.terminal(botId, threadId, record.messageId, "expired").catch(() => {});
    }
  }

  /** One terminal transition per card. The first Done/Dismiss/Expiry releases
   * the browser; duplicates return the settled outcome. */
  async terminal(
    botId: string,
    threadId: string,
    messageId: string,
    status: "done" | "dismissed" | "expired",
    note?: string,
    options: { resume?: boolean; attempt?: number } = {},
  ): Promise<TerminalTakeoverResult> {
    const key = this.key(threadId, messageId);
    const card = this.deps.getCard(botId, threadId, messageId);
    if (!card) throw new ToolLayerTakeoverError(404, "no such takeover request");
    if (card.status !== "pending") {
      this.clearTimer(threadId, messageId);
      this.clearScreenshot(messageId);
      return { status: card.status, resumed: card.resumed === true, changed: false };
    }
    const inFlight = this.terminalizing.get(key);
    if (inFlight) return inFlight.then((settled) => ({ ...settled, changed: false }));

    const run = (async (): Promise<TerminalTakeoverResult> => {
      const actor = this.deps.actorFor(botId, threadId);
      let terminalStatus = status;
      if (status === "done") {
        try {
          // Hand back the SAME page; no release, no restart.
          const handedBack = await this.deps.client.handBack(actor, card.sessionId, card.generation);
          if (!handedBack.handedBack) terminalStatus = "expired";
        } catch (error) {
          // The session expired before the click: settle as declined rather
          // than claiming the bot resumed on a page that no longer exists.
          if (error instanceof ToolLayerTakeoverError && error.status === 409) {
            terminalStatus = "expired";
            await this.deps.client.release(actor, card.sessionId, card.generation).catch(() => {});
          } else {
            throw error;
          }
        }
      } else {
        await this.deps.client.release(actor, card.sessionId, card.generation);
      }

      const shouldResume = options.resume !== false && terminalStatus === "done";
      this.clearTimer(threadId, messageId);
      this.clearScreenshot(messageId);
      this.deps.patchCard(threadId, messageId, {
        ...card,
        status: terminalStatus,
        error: undefined,
        ...(shouldResume ? {} : { resumed: false }),
      });
      if (shouldResume) {
        this.deps.markResumeInFlight(threadId, messageId);
        this.deps.resume(botId, threadId, messageId, note);
      }
      const settled = this.deps.getCard(botId, threadId, messageId);
      return {
        status: terminalStatus,
        resumed: settled?.resumed === true,
        changed: true,
      };
    })()
      .catch((error) => {
        if (status !== "done") {
          this.scheduleReleaseRetry(botId, threadId, messageId, status, (options.attempt ?? 0) + 1, note);
        }
        throw error;
      })
      .finally(() => {
        this.terminalizing.delete(key);
      });
    this.terminalizing.set(key, run);
    return run;
  }

  private scheduleReleaseRetry(
    botId: string,
    threadId: string,
    messageId: string,
    status: "dismissed" | "expired",
    attempt: number,
    note?: string,
  ): void {
    const key = this.key(threadId, messageId);
    const previous = this.retryTimers.get(key);
    if (previous) clearTimeout(previous);
    if (attempt > TAKEOVER_RELEASE_RETRY_MS.length) {
      this.finalizeExpired(botId, threadId, messageId, key);
      return;
    }
    const delay = TAKEOVER_RELEASE_RETRY_MS[attempt - 1]!;
    this.retryAttempts.set(key, attempt);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.terminal(botId, threadId, messageId, status, note, { attempt }).catch((error) => {
        this.log("warn", `[takeover] release retry failed session=${messageId}: ${errorText(error)}`);
      });
    }, delay);
    timer.unref?.();
    this.retryTimers.set(key, timer);
    this.log(
      "warn",
      `[takeover] release failed; retry ${attempt}/${TAKEOVER_RELEASE_RETRY_MS.length} in ${delay}ms thread=${threadId} card=${messageId}`,
    );
  }

  private finalizeExpired(botId: string, threadId: string, messageId: string, key: string): void {
    const card = this.deps.getCard(botId, threadId, messageId);
    if (card) {
      this.deps.patchCard(threadId, messageId, { ...card, status: "expired", resumed: false });
    }
    this.clearScreenshot(messageId);
    this.expiryTimers.delete(key);
    this.retryTimers.delete(key);
    this.retryAttempts.delete(key);
    this.log("warn", `[takeover] release gave up; card settled expired thread=${threadId} card=${messageId}`);
  }

  /** Release the live browser once the agent's resumed turn ends. The card
   * stays done; a newer pending card reuses the session, so only the latest
   * settled card is considered. A queued continuation has not used the
   * browser yet. */
  releaseSettled(botId: string, threadId: string): void {
    const settled = this.deps.latestSettled(threadId);
    if (!settled) return;
    if (this.deps.isResumeQueued(threadId, settled.messageId)) return;
    // The first turn.completed after dispatch is the continuation ending.
    this.deps.consumeResumeInFlight(threadId, settled.messageId);
    let actor: TakeoverActor;
    try {
      actor = this.deps.actorFor(botId, threadId);
    } catch (error) {
      this.log(
        "warn",
        `[takeover] release after turn skipped session=${settled.card.sessionId}: ${errorText(error)}`,
      );
      return;
    }
    void this.deps.client.release(actor, settled.card.sessionId, settled.card.generation).then(
      (released) => {
        if (released) {
          this.log(
            "info",
            `[takeover] release after turn session=${settled.card.sessionId} bot=${botId} thread=${threadId}`,
          );
        }
      },
      (error) => {
        this.log(
          "warn",
          `[takeover] release after turn failed session=${settled.card.sessionId} bot=${botId} thread=${threadId}: ${errorText(error)}`,
        );
      },
    );
  }

  /** Re-arm TTLs for cards that outlived this process. */
  restore(pending: ReadonlyArray<{ botId: string; threadId: string; messageId: string }>): void {
    for (const entry of pending) this.scheduleExpiry(entry.botId, entry.threadId, entry.messageId);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
