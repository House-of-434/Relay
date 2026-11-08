/** Login-session ownership: one persistent Bladebro profile per user, at most
 * one active human takeover per profile, and task-level waiting dependencies
 * on that takeover. Pure and tested offline; Bladebro execution stays in
 * `infra/bladebro.ts` (CLI), this manager owns only ownership + fencing. */
import { canonicalUserId } from "./workspace-identity.js";

/** Hard lifetime of one browser takeover (matches the viewer token TTL). */
export const LOGIN_TAKEOVER_TTL_MS = 30 * 60_000;

export type SessionState =
  | "starting"
  | "ready"
  | "agent_active"
  | "user_takeover"
  | "releasing"
  | "closed";

export interface TakeoverEvent {
  kind: "takeover_completed" | "takeover_expired" | "takeover_failed";
  userId: string;
  sessionId: string;
  generation: number;
  taskIds: string[];
}

export interface LoginSession {
  id: string;
  userId: string;
  generation: number;
  state: SessionState;
  owner: string;
  waiters: string[];
  openedAt: number;
}

export interface LoginSessionOptions {
  maxConcurrent?: number;
  /** Hard lifetime of one takeover; its browser resources are reclaimed
   * lazily on the next acquire or release. */
  maxAgeMs?: number;
  now?: () => number;
  id?: () => string;
  onEvent?: (event: TakeoverEvent) => void;
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
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly onEvent: ((event: TakeoverEvent) => void) | undefined;
  private counter = 0;

  constructor(options: LoginSessionOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxAgeMs = options.maxAgeMs ?? LOGIN_TAKEOVER_TTL_MS;
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => `login_${++this.counter}_${this.now().toString(36)}`);
    this.onEvent = options.onEvent;
  }

  /** Exclusive-ownership check: agent browser ops refuse while in takeover. */
  isUserTakeover(userId: unknown): boolean {
    const id = this.sessionIdFor(userId);
    return id ? this.sessions.get(id)?.state === "user_takeover" : false;
  }

  sessionIdFor(userId: unknown): string | undefined {
    return this.byUser.get(canonicalUserId(userId));
  }

  /** Acquire or join the single headful session for a profile. */
  acquire(userId: unknown, taskId: string): LoginSession {
    const uid = canonicalUserId(userId);
    this.sweepExpired();
    const existingId = this.byUser.get(uid);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      existing.waiters.push(taskId);
      return existing;
    }
    const active = [...this.sessions.values()].filter((s) => s.state !== "closed").length;
    if (active >= this.maxConcurrent) throw new Error("login browser is busy; try again later");
    const session: LoginSession = {
      id: this.nextId(),
      userId: uid,
      generation: 1,
      state: "agent_active",
      owner: taskId,
      waiters: [taskId],
      openedAt: this.now(),
    };
    this.sessions.set(session.id, session);
    this.byUser.set(uid, session.id);
    return session;
  }

  /** User takes control: server-enforced agent pause until release. */
  requestHuman(userId: unknown, taskId: string): LoginSession {
    const session = this.acquire(userId, taskId);
    if (session.state === "agent_active") session.state = "user_takeover";
    return session;
  }

  /** Returns control; publishes durable completion for orchestrator fan-out.
   * Idempotent once the session is gone: duplicate terminal requests from the
   * card return the same settled result instead of failing. */
  release(sessionId: string, generation: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.generation !== generation) throw new Error("stale release fenced");
    if (session.state !== "user_takeover" && session.state !== "agent_active") {
      throw new Error(`cannot release from ${session.state}`);
    }
    session.state = "closed";
    this.sessions.delete(sessionId);
    this.byUser.delete(session.userId);
    this.onEvent?.({
      kind: "takeover_completed",
      userId: session.userId,
      sessionId,
      generation,
      taskIds: [...session.waiters],
    });
    return true;
  }

  /** Reclaim takeovers that outlived their TTL. Lazy by design: it runs on the
   * next acquire/release, so an idle server holds no timers. */
  sweepExpired(): void {
    for (const session of this.sessions.values()) {
      if (this.now() - session.openedAt < this.maxAgeMs) continue;
      session.state = "closed";
      this.sessions.delete(session.id);
      this.byUser.delete(session.userId);
      this.onEvent?.({
        kind: "takeover_expired",
        userId: session.userId,
        sessionId: session.id,
        generation: session.generation,
        taskIds: [...session.waiters],
      });
    }
  }

  /** Session metadata for an authorized release/mint route. Null when the
   * session is gone or owned by a different user. */
  ownedSession(userId: unknown, sessionId: string): LoginSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.userId === canonicalUserId(userId) ? session : null;
  }

  expire(sessionId: string, generation: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.generation !== generation) return;
    session.state = "closed";
    this.sessions.delete(sessionId);
    this.byUser.delete(session.userId);
    this.onEvent?.({
      kind: "takeover_expired",
      userId: session.userId,
      sessionId,
      generation,
      taskIds: [...session.waiters],
    });
  }

  /** Test seam: deterministic generation bump (new browser process). */
  bumpGeneration(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.generation += 1;
  }
}
