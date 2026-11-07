/** Viewer token: 128-bit random, short-lived, scoped to one session + user,
 * immediately revocable. Never included in model-visible tool output. Pure
 * and tested offline. */
import { randomBytes } from "node:crypto";

export interface ViewerToken {
  value: string;
  sessionId: string;
  userId: string;
  generation: number;
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

  mint(sessionId: string, userId: string, generation = 1): ViewerToken {
    const token: ViewerToken = {
      value: randomBytes(16).toString("hex"),
      sessionId,
      userId,
      generation,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tokens.set(token.value, token);
    return token;
  }

  validate(value: string, sessionId: string, userId: string): boolean {
    const token = this.find(value);
    return token === undefined ? false : token.sessionId === sessionId && token.userId === userId;
  }

  find(value: string): ViewerToken | undefined {
    const token = this.tokens.get(value);
    if (!token) return undefined;
    if (this.now() > token.expiresAt) {
      this.tokens.delete(value);
      return undefined;
    }
    return token;
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
