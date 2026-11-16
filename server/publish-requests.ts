import { randomUUID } from "node:crypto";

/** A local commit waiting for a person to approve its publication.
 *
 * The payload is server-owned. The model cannot change the repository, branch,
 * commit, or attachments after the card is shown. The broker receives the
 * exact signed payload only when the person approves. */

export const PUBLISH_REQUEST_TTL_MS = 30 * 60_000;

export interface PendingPublish {
  requestId: string;
  userId: string;
  botId: string;
  threadId: string;
  repo: string;
  path: string;
  branch: string;
  commit: string;
  title: string;
  body: string;
  attachments: string[];
  workspace: string;
  diffStat: string;
  createdAt: number;
}

export type PublishResolution =
  | { state: "approved"; request: PendingPublish }
  | { state: "denied"; request: PendingPublish }
  | { state: "already"; outcome: "approved" | "denied" }
  | { state: "missing" };

export class PublishRequests {
  private readonly pending = new Map<string, PendingPublish>();
  private readonly settled = new Map<string, { at: number; outcome: "approved" | "denied" }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  submit(input: Omit<PendingPublish, "requestId" | "createdAt">): PendingPublish {
    this.evict();
    const requestId = randomUUID();
    const request: PendingPublish = { ...input, requestId, createdAt: this.now() };
    this.pending.set(requestId, request);
    return request;
  }

  take(requestId: string, behavior: "allow" | "deny"): PublishResolution {
    this.evict();
    const request = this.pending.get(requestId);
    if (!request) {
      const settled = this.settled.get(requestId);
      if (settled) return { state: "already", outcome: settled.outcome };
      return { state: "missing" };
    }
    this.pending.delete(requestId);
    const outcome = behavior === "allow" ? "approved" : "denied";
    this.settled.set(requestId, { at: this.now(), outcome });
    return { state: outcome, request };
  }

  /** Re-read after a card resolve to preserve the payload for execution. */
  peek(requestId: string): PendingPublish | undefined {
    this.evict();
    return this.pending.get(requestId);
  }

  private evict(): void {
    const cutoff = this.now() - PUBLISH_REQUEST_TTL_MS;
    for (const [id, request] of this.pending) {
      if (request.createdAt <= cutoff) this.pending.delete(id);
    }
    const replayCutoff = this.now() - PUBLISH_REQUEST_TTL_MS * 2;
    for (const [id, settled] of this.settled) {
      if (settled.at <= replayCutoff) this.settled.delete(id);
    }
  }
}
