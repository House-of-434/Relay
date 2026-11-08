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

/** A sign-in card that never gets acted on expires after this long. */
export const LOGIN_USER_TAKEOVER_MS = 30 * 60_000;
/** Normal cleanup: no interactive use for this long. */
export const LOGIN_IDLE_MS = 10 * 60_000;
/** Safety ceiling only; never extended by activity. */
export const LOGIN_MAX_LIFETIME_MS = 12 * 60 * 60_000;
/** Viewer token TTL (matches the card's sign-in window). */
export const LOGIN_TAKEOVER_TTL_MS = LOGIN_USER_TAKEOVER_MS;

export type SessionState = "agent_active" | "user_takeover";
export type CloseReason = "released" | "expired" | "idle" | "hard-cap";

export interface TakeoverEvent {
  kind: "session_closed";
  reason: CloseReason;
  userId: string;
  botId: string;
  threadId: string;
  sessionId: string;
  generation: number;
  taskIds: string[];
}

export interface LoginSession {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  generation: number;
  state: SessionState;
  owner: string;
  waiters: string[];
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

export interface LoginSessionOptions {
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

/** Orchestrator fan-out: resume each authorized waiter independently; one
 * failure never blocks the others. Pure over task ids. */
export async function fanOutResume(
  taskIds: string[],
  resume: (taskId: string) => Promise<void>,
): Promise<Array<{ taskId: string; ok: boolean; error?: string }>> {
  const outcomes: Array<{ taskId: string; ok: boolean; error?: string }> = [];
  for (const taskId of taskIds) {
    try {
      await resume(taskId);
      outcomes.push({ taskId, ok: true });
    } catch (error) {
      outcomes.push({ taskId, ok: false, error: error instanceof Error ? error.message : "resume failed" });
    }
  }
  return outcomes;
}

export class LoginSessionManager {
  private readonly sessions = new Map<string, LoginSession>();
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

  constructor(options: LoginSessionOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.idleMs = options.idleMs ?? LOGIN_IDLE_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? LOGIN_MAX_LIFETIME_MS;
    this.userTakeoverMs = options.userTakeoverMs ?? LOGIN_USER_TAKEOVER_MS;
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => `login_${++this.counter}_${this.now().toString(36)}`);
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

  sessionIdFor(userId: unknown): string | undefined {
    return this.byUser.get(canonicalUserId(userId));
  }

  /** The interactive session this exact actor may drive, if the agent holds
   * control. Binding is server-derived: a different bot or thread never
   * attaches to someone else's live page. */
  agentSession(actor: SessionActor): LoginSession | null {
    const session = this.sessions.get(this.byUser.get(canonicalUserId(actor.userId)) ?? "");
    if (!session) return null;
    if (session.botId !== actor.botId || session.threadId !== actor.threadId) return null;
    return session.state === "agent_active" ? session : null;
  }

  /** User takes control: one session per user, bound to the originating
   * bot + thread. A competing thread gets a clear busy error; the owner is
   * never pre-empted. */
  requestHuman(actor: SessionActor, taskId: string, display?: string): { session: LoginSession; created: boolean } {
    this.sweepExpired();
    const uid = canonicalUserId(actor.userId);
    const existingId = this.byUser.get(uid);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      if (existing.botId !== actor.botId || existing.threadId !== actor.threadId) {
        throw new Error("interactive browser is busy on another task; wait for it to finish, then retry");
      }
      if (existing.state !== "user_takeover") {
        existing.state = "user_takeover";
        existing.stateSince = this.now();
      }
      if (display) existing.display = display;
      existing.lastUsedAt = this.now();
      existing.waiters.push(taskId);
      return { session: existing, created: false };
    }
    const active = this.sessions.size;
    if (active >= this.maxConcurrent) throw new Error("login browser is at capacity; try again shortly");
    const lease = this.leaseFor?.(uid);
    if (this.leaseFor && !lease) {
      throw new Error("interactive browser is busy on another task; wait for it to finish, then retry");
    }
    const now = this.now();
    const session: LoginSession = {
      id: this.nextId(),
      userId: uid,
      botId: actor.botId,
      threadId: actor.threadId,
      generation: 1,
      state: "user_takeover",
      owner: taskId,
      waiters: [taskId],
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
  ownedSession(userId: unknown, sessionId: string): LoginSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.userId === canonicalUserId(userId) ? session : null;
  }

  get(sessionId: string): LoginSession | undefined {
    return this.sessions.get(sessionId);
  }

  expire(sessionId: string, generation: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.generation !== generation) return;
    this.close(session, "expired");
  }

  /** Test seam: deterministic generation bump (new browser process). */
  bumpGeneration(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.generation += 1;
  }

  private close(session: LoginSession, reason: CloseReason): void {
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
      taskIds: [...session.waiters],
    });
  }
}
