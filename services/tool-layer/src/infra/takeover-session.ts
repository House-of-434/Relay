/** Interactive browser session ownership.
 *
 * The session belongs to the USER, not to a turn: it outlives tool calls and
 * turns, and control switches exclusively between the person and the agent.
 * One session per user (bound to the originating bot + thread), two globally.
 *
 * Retention: a 10-minute idle timeout is the normal cleanup; a 12-hour hard
 * cap is only a safety ceiling and is never extended by activity. The
 * persistent browser profile is never deleted here — closing the session
 * releases runtime resources and the profile lock only.
 */
import { canonicalUserId } from "./workspace-identity.js";

/** A sign-in card that never gets acted on expires after this long. The
 * harness card TTL is authoritative; this is the tool-layer fallback. */
export const TAKEOVER_WINDOW_MS = 10 * 60_000;
/** Long agent-turn backstop: this much wall-clock without a single browser
 * call means the turn is not using the page. Turn-end release is the normal
 * path; the 12-hour hard cap is the ceiling. */
export const TAKEOVER_IDLE_MS = 60 * 60_000;
/** Safety ceiling only; never extended by activity. */
export const TAKEOVER_MAX_LIFETIME_MS = 12 * 60 * 60_000;
/** Viewer token TTL (matches the card's sign-in window). */
export const TAKEOVER_TTL_MS = TAKEOVER_WINDOW_MS;

export type SessionState = "agent_active" | "user_takeover";
export type CloseReason = "released" | "expired" | "idle" | "hard-cap";

/** Why another task may not use the user's live browser right now. The
 * holder's identity stays in the logs, never in the tool error. */
export function takeoverBusyMessage(state: SessionState): string {
  return state === "user_takeover"
    ? "The person is using the interactive browser in another chat; wait for them to hand it back."
    : "The interactive browser is still in use by another task; it will be released when that task finishes.";
}

export interface TakeoverEvent {
  kind: "session_closed";
  reason: CloseReason;
  userId: string;
  botId: string;
  threadId: string;
  sessionId: string;
  generation: number;
}

export interface TakeoverSession {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  generation: number;
  state: SessionState;
  /** X display the live browser renders on; survives handoff. */
  display?: string;
  createdAt: number;
  lastUsedAt: number;
  /** When the current controller took over: user-takeover TTL counts from here. */
  stateSince: number;
  lease?: { release(): void };
}

export interface SessionActor {
  userId: string;
  botId: string;
  threadId: string;
}

export interface TakeoverSessionOptions {
  maxConcurrent?: number;
  idleMs?: number;
  maxLifetimeMs?: number;
  userTakeoverMs?: number;
  now?: () => number;
  id?: () => string;
  onEvent?: (event: TakeoverEvent) => void;
  /** Cross-process reservation. Returns null when another process holds the
   * user's interactive session; the returned release is idempotent. */
  leaseFor?: (userId: string) => { release(): void } | null;
}

export class TakeoverSessionManager {
  private readonly sessions = new Map<string, TakeoverSession>();
  private readonly byUser = new Map<string, string>();
  private readonly maxConcurrent: number;
  private readonly idleMs: number;
  private readonly maxLifetimeMs: number;
  private readonly userTakeoverMs: number;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly onEvent: ((event: TakeoverEvent) => void) | undefined;
  private readonly leaseFor: ((userId: string) => { release(): void } | null) | undefined;
  private counter = 0;

  constructor(options: TakeoverSessionOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.idleMs = options.idleMs ?? TAKEOVER_IDLE_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? TAKEOVER_MAX_LIFETIME_MS;
    this.userTakeoverMs = options.userTakeoverMs ?? TAKEOVER_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => `takeover_${++this.counter}_${this.now().toString(36)}`);
    this.onEvent = options.onEvent;
    this.leaseFor = options.leaseFor;
  }

  /** Exclusive-control check: agent browser ops refuse while the person has
   * control. An `agent_active` session is the interactive lane and allows
   * them. */
  isUserTakeover(userId: unknown): boolean {
    const id = this.byUser.get(canonicalUserId(userId));
    return id ? this.sessions.get(id)?.state === "user_takeover" : false;
  }

  /** Any live interactive session for this user, regardless of thread. Used
   * to keep unrelated tasks from reusing (and restarting) the live daemon. */
  sessionForUser(userId: unknown): TakeoverSession | null {
    const id = this.byUser.get(canonicalUserId(userId));
    return id ? this.sessions.get(id) ?? null : null;
  }

  /** The interactive session this exact actor may drive, if the agent holds
   * control. Binding is server-derived: a different bot or thread never
   * attaches to someone else's live page. */
  agentSession(actor: SessionActor): TakeoverSession | null {
    const session = this.sessions.get(this.byUser.get(canonicalUserId(actor.userId)) ?? "");
    if (!session) return null;
    if (session.botId !== actor.botId || session.threadId !== actor.threadId) return null;
    return session.state === "agent_active" ? session : null;
  }

  /** User takes control: one session per user, bound to the originating
   * bot + thread. A competing thread gets a clear busy error; the owner is
   * never pre-empted. */
  requestHuman(actor: SessionActor, display?: string): { session: TakeoverSession; created: boolean } {
    this.sweepExpired();
    const uid = canonicalUserId(actor.userId);
    const existingId = this.byUser.get(uid);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      if (existing.botId !== actor.botId || existing.threadId !== actor.threadId) {
        console.warn(
          `[takeover] busy: owner=${existing.botId}/${existing.threadId} request=${actor.botId}/${actor.threadId}`,
        );
        throw new Error(takeoverBusyMessage(existing.state));
      }
      if (existing.state !== "user_takeover") {
        existing.state = "user_takeover";
        existing.stateSince = this.now();
      }
      if (display) existing.display = display;
      existing.lastUsedAt = this.now();
      return { session: existing, created: false };
    }
    const active = this.sessions.size;
    if (active >= this.maxConcurrent) throw new Error("live browser is at capacity; try again shortly");
    const lease = this.leaseFor?.(uid);
    if (this.leaseFor && !lease) {
      console.warn(`[takeover] lease refused userId=${uid}`);
      throw new Error(takeoverBusyMessage("agent_active"));
    }
    const now = this.now();
    const session: TakeoverSession = {
      id: this.nextId(),
      userId: uid,
      botId: actor.botId,
      threadId: actor.threadId,
      generation: 1,
      state: "user_takeover",
      ...(display ? { display } : {}),
      createdAt: now,
      lastUsedAt: now,
      stateSince: now,
      ...(lease ? { lease } : {}),
    };
    this.sessions.set(session.id, session);
    this.byUser.set(uid, session.id);
    return { session, created: true };
  }

  /** Agent takes over the same live page. Idempotent. */
  handBack(sessionId: string, generation: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale hand-back fenced");
    if (session.state === "agent_active") return true;
    session.state = "agent_active";
    session.stateSince = this.now();
    session.lastUsedAt = this.now();
    return true;
  }

  /** Bind the display the browser renders on (set once, after allocation). */
  attachDisplay(sessionId: string, display: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.display = display;
  }

  /** Record interactive use (agent browser call or viewer heartbeat). */
  touchByUser(userId: unknown): void {
    const id = this.byUser.get(canonicalUserId(userId));
    if (id) this.touchSession(id);
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsedAt = this.now();
  }

  /** Returns control; idempotent once the session is gone. */
  release(sessionId: string, generation: number, reason: CloseReason = "released"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale release fenced");
    this.close(session, reason);
    return true;
  }

  /** Reclaim idle and over-age sessions. Lazy by design; a periodic sweep a
   * level above calls it as well. */
  sweepExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.createdAt >= this.maxLifetimeMs) {
        this.close(session, "hard-cap");
        continue;
      }
      if (session.state === "user_takeover") {
        if (now - session.stateSince >= this.userTakeoverMs) this.close(session, "expired");
        continue;
      }
      if (now - session.lastUsedAt >= this.idleMs) this.close(session, "idle");
    }
  }

  /** Session metadata for an authorized release/mint route. Null when the
   * session is gone or owned by a different user. */
  ownedSession(userId: unknown, sessionId: string): TakeoverSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.userId === canonicalUserId(userId) ? session : null;
  }

  get(sessionId: string): TakeoverSession | undefined {
    return this.sessions.get(sessionId);
  }

  private close(session: TakeoverSession, reason: CloseReason): void {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    this.byUser.delete(session.userId);
    try {
      session.lease?.release();
    } catch {
      /* the lease release is idempotent; a stale lock is reclaimed by age */
    }
    this.onEvent?.({
      kind: "session_closed",
      reason,
      userId: session.userId,
      botId: session.botId,
      threadId: session.threadId,
      sessionId: session.id,
      generation: session.generation,
    });
  }
}
