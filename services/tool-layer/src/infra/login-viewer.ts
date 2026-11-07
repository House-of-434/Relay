/** Viewer token: 128-bit random, short-lived, scoped to one session + user,
 * immediately revocable. Never included in model-visible tool output. Pure
 * and tested offline. */
import { randomBytes } from "node:crypto";

export interface ViewerToken {
  value: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

export class ViewerTokens {
  private readonly tokens = new Map<string, ViewerToken>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
  }

  mint(sessionId: string, userId: string): ViewerToken {
    const token: ViewerToken = {
      value: randomBytes(16).toString("hex"),
      sessionId,
      userId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tokens.set(token.value, token);
    return token;
  }

  validate(value: string, sessionId: string, userId: string): boolean {
    const token = this.tokens.get(value);
    if (!token) return false;
    if (this.now() > token.expiresAt) {
      this.tokens.delete(value);
      return false;
    }
    return token.sessionId === sessionId && token.userId === userId;
  }

  revoke(value: string): void {
    this.tokens.delete(value);
  }

  revokeSession(sessionId: string): void {
    for (const [value, token] of this.tokens) {
      if (token.sessionId === sessionId) this.tokens.delete(value);
    }
  }
}
