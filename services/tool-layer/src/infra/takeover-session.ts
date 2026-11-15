/** Browser session ownership.
 *
 * One live browser session per user, bound to the exact turn that acquired
 * it. The session survives tool calls but never the turn: closing it releases
 * the viewer, display and cross-process lease, while the daemon, page and
 * profile stay alive for the next turn.
 *
 * Identity is `(userId, botId, threadId, turnId)`. A different turn never
 * inherits a session by knowing the user's browser; it must acquire its own.
 * Every ownership transition bumps the generation, and every action validates
 * the full identity plus the generation.
 */
import { canonicalUserId } from "./workspace-identity.js";

/** A sign-in card that never gets acted on expires after this long. The
 * harness card TTL is authoritative; this is the tool-layer fallback. */
export const TAKEOVER_WINDOW_MS = 10 * 60_000;
/** Agent browser session idle. Turn end is the normal close; this is the
 * backstop for a lost close request. */
export const TAKEOVER_IDLE_MS = 10 * 60_000;
/** Safety ceiling only; never extended by activity. */
export const TAKEOVER_MAX_LIFETIME_MS = 12 * 60 * 60_000;
/** Viewer token TTL (matches the card's sign-in window). */
export const TAKEOVER_TTL_MS = TAKEOVER_WINDOW_MS;

export type SessionState = "agent_headless" | "agent_headful" | "user_takeover";
export type SessionLane = "headless" | "headful";
export type CloseReason = "released" | "expired" | "idle" | "hard-cap";

/** Why another task may not use the user's live browser right now. The
 * holder's identity stays in the logs, never in the tool error. */
export function takeoverBusyMessage(state: SessionState): string {
  return state === "user_takeover"
    ? "The person is using the interactive browser in another chat; wait for them to hand it back."
    : "The browser is still in use by another task; it will be released when that turn finishes.";
}

export interface TakeoverEvent {
  kind: "session_closed";
  reason: CloseReason;
  userId: string;
  botId: string;
  threadId: string;
  turnId?: string;
  sessionId: string;
  generation: number;
}

export interface TakeoverSession {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  /** The provider turn generation that acquired this session. */
  turnId?: string;
  /** Monotonic fence for every ownership transition. */
  generation: number;
  state: SessionState;
  /** X display the live browser renders on; survives handoff. */
  display?: string;
  createdAt: number;
  lastUsedAt: number;
  /** When the current controller took over: user-takeover TTL counts from here. */
  stateSince: number;
  /** An operation is running; idle reclamation must not close it. */
  busy: boolean;
  lease?: { release(): void };
}

export interface SessionActor {
  userId: string;
  botId: string;
  threadId: string;
  turnId?: string;
}

export interface TakeoverSessionOptions {
  /** Maximum simultaneous human viewers. Agent sessions are limited by the
   * browser daemon cap instead. */
  maxConcurrent?: number;
  idleMs?: number;
  maxLifetimeMs?: number;
  userTakeoverMs?: number;
  now?: () => number;
  id?: () => string;
  onEvent?: (event: TakeoverEvent) => void;
  /** Cross-process reservation. Returns null when another process holds the
   * user's browser session; the returned release is idempotent. */
  leaseFor?: (userId: string) => { release(): void } | null;
}

const sameTurn = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined || left === right;

const sameActor = (session: TakeoverSession, actor: SessionActor): boolean =>
  session.userId === canonicalUserId(actor.userId) &&
  session.botId === actor.botId &&
  session.threadId === actor.threadId &&
  sameTurn(session.turnId, actor.turnId);

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
    this.nextId = options.id ?? (() => `browser_${++this.counter}_${this.now().toString(36)}`);
    this.onEvent = options.onEvent;
    this.leaseFor = options.leaseFor;
  }

  /** Agent browser ops refuse while the person has control. */
  isUserTakeover(userId: unknown): boolean {
    const id = this.byUser.get(canonicalUserId(userId));
    return id ? this.sessions.get(id)?.state === "user_takeover" : false;
  }

  /** Any live session for this user, regardless of turn. */
  sessionForUser(userId: unknown): TakeoverSession | null {
    const id = this.byUser.get(canonicalUserId(userId));
    return id ? this.sessions.get(id) ?? null : null;
  }

  /** The session this exact actor may drive, when the agent holds control. */
  agentSession(actor: SessionActor): TakeoverSession | null {
    const session = this.sessionForUser(actor.userId);
    if (!session) return null;
    if (!sameActor(session, actor)) return null;
    return session.state === "user_takeover" ? null : session;
  }

  /** The stored session for this actor even while a person has control.
   * Used by transition code that needs the display or generation. */
  sessionForActor(actor: SessionActor): TakeoverSession | null {
    const session = this.sessionForUser(actor.userId);
    return session && sameActor(session, actor) ? session : null;
  }

  /** Acquire the user's browser for this turn and lane. A competing turn is
   * busy; the same actor reuses its session. */
  acquire(actor: SessionActor, lane: SessionLane = "headless"): { session: TakeoverSession; created: boolean } {
    this.sweepExpired();
    const uid = canonicalUserId(actor.userId);
    const existingId = this.byUser.get(uid);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      if (!sameActor(existing, actor)) {
        console.warn(`[browser] busy: owner=${existing.botId}/${existing.threadId}/${existing.turnId ?? "-"} request=${actor.botId}/${actor.threadId}/${actor.turnId ?? "-"}`);
        throw new Error(takeoverBusyMessage(existing.state));
      }
      // A handed-back session has no turn owner until the resumed turn
      // arrives. That turn adopts it; a different turn is still busy.
      if (!existing.turnId && actor.turnId) existing.turnId = actor.turnId;
      existing.lastUsedAt = this.now();
      if (lane === "headful" && existing.state === "agent_headless") {
        // The caller upgrades only after the headful browser starts.
      }
      return { session: existing, created: false };
    }
    const lease = this.leaseFor?.(uid);
    if (this.leaseFor && !lease) {
      console.warn(`[browser] lease refused userId=${uid}`);
      throw new Error(takeoverBusyMessage("agent_headless"));
    }
    const now = this.now();
    const session: TakeoverSession = {
      id: this.nextId(),
      userId: uid,
      botId: actor.botId,
      threadId: actor.threadId,
      ...(actor.turnId ? { turnId: actor.turnId } : {}),
      generation: 1,
      state: lane === "headful" ? "agent_headful" : "agent_headless",
      createdAt: now,
      lastUsedAt: now,
      stateSince: now,
      busy: false,
      ...(lease ? { lease } : {}),
    };
    this.sessions.set(session.id, session);
    this.byUser.set(uid, session.id);
    return { session, created: true };
  }

  /** Mark a headless session headful after the headful browser is ready. */
  upgradeHeadful(sessionId: string, generation: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale headful upgrade fenced");
    if (session.state === "agent_headful" || session.state === "user_takeover") return true;
    session.state = "agent_headful";
    session.stateSince = this.now();
    session.lastUsedAt = this.now();
    session.generation += 1;
    return true;
  }

  /** User takes control: one session per user. A competing turn gets busy. */
  requestHuman(actor: SessionActor, display?: string): { session: TakeoverSession; created: boolean } {
    this.sweepExpired();
    const uid = canonicalUserId(actor.userId);
    const existingId = this.byUser.get(uid);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      if (!sameActor(existing, actor)) {
        console.warn(
          `[browser] busy: owner=${existing.botId}/${existing.threadId}/${existing.turnId ?? "-"} request=${actor.botId}/${actor.threadId}/${actor.turnId ?? "-"}`,
        );
        throw new Error(takeoverBusyMessage(existing.state));
      }
      if (existing.state !== "user_takeover") {
        if (this.countState("user_takeover") >= this.maxConcurrent) {
          throw new Error("live browser is at capacity; try again shortly");
        }
        existing.state = "user_takeover";
        existing.stateSince = this.now();
        existing.generation += 1;
      }
      if (display) existing.display = display;
      existing.lastUsedAt = this.now();
      return { session: existing, created: false };
    }
    if (this.countState("user_takeover") >= this.maxConcurrent) {
      throw new Error("live browser is at capacity; try again shortly");
    }
    const lease = this.leaseFor?.(uid);
    if (this.leaseFor && !lease) {
      console.warn(`[browser] lease refused userId=${uid}`);
      throw new Error(takeoverBusyMessage("agent_headless"));
    }
    const now = this.now();
    const session: TakeoverSession = {
      id: this.nextId(),
      userId: uid,
      botId: actor.botId,
      threadId: actor.threadId,
      ...(actor.turnId ? { turnId: actor.turnId } : {}),
      generation: 1,
      state: "user_takeover",
      ...(display ? { display } : {}),
      createdAt: now,
      lastUsedAt: now,
      stateSince: now,
      busy: false,
      ...(lease ? { lease } : {}),
    };
    this.sessions.set(session.id, session);
    this.byUser.set(uid, session.id);
    return { session, created: true };
  }

  /** Agent takes control of the same live page. Idempotent. */
  handBack(sessionId: string, generation: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale hand-back fenced");
    if (session.state !== "user_takeover") return true;
    session.state = session.display ? "agent_headful" : "agent_headless";
    // The resumed turn has not been minted yet. The next turn of this exact
    // bot/thread adopts the same browser; a different bot/thread stays busy.
    session.turnId = undefined;
    session.stateSince = this.now();
    session.lastUsedAt = this.now();
    session.generation += 1;
    return true;
  }

  /** Bind the display the browser renders on (set once, after allocation). */
  attachDisplay(sessionId: string, display: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.display = display;
  }

  /** Adopt a handed-back session for the resumed turn. Only the exact
   * bot/thread may claim it; the previous turn is already revoked. */
  claimTurn(sessionId: string, turnId: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || !turnId || session.turnId) return;
    session.turnId = turnId;
  }

  /** Record browser use. */
  touchByUser(userId: unknown): void {
    const id = this.byUser.get(canonicalUserId(userId));
    if (id) this.touchSession(id);
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsedAt = this.now();
  }

  markBusy(sessionId: string, busy: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) session.busy = busy;
  }

  isBusy(userId: unknown): boolean {
    return this.sessionForUser(userId)?.busy === true;
  }

  hasSession(userId: unknown): boolean {
    return this.sessionForUser(userId) !== null;
  }

  /** Strict close used by the takeover card. Stale generations throw. */
  release(sessionId: string, generation: number, reason: CloseReason = "released"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale release fenced");
    this.close(session, reason);
    return true;
  }

  /** Close only the exact session a turn was granted. A delayed close for an
   * older turn is a harmless no-op. */
  closeForActor(actor: SessionActor, sessionId: string, generation: number, reason: CloseReason = "released"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!sameActor(session, actor)) return false;
    if (session.generation !== generation) return false;
    this.close(session, reason);
    return true;
  }

  /** Close the actor's current session without a session id (used by an
   * idempotent turn-end close). Bound to the actor's turn. */
  closeTurn(actor: SessionActor, reason: CloseReason = "released"): boolean {
    const session = this.sessionForActor(actor);
    if (!session) return false;
    // A pending human takeover is a continuation, not a finished turn. Its
    // session survives until hand-back, dismiss, expiry or the hard cap.
    if (session.state === "user_takeover") return false;
    this.close(session, reason);
    return true;
  }

  /** Reclaim idle and over-age sessions. Busy operations are never closed. */
  sweepExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.busy) continue;
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

  private countState(state: SessionState): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.state === state) count += 1;
    return count;
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
      ...(session.turnId ? { turnId: session.turnId } : {}),
      sessionId: session.id,
      generation: session.generation,
    });
  }
}
