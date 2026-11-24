import type { CaptureStatus, MeetingRow } from "./types.js";

/** Capture lifecycle order. A capture only ever moves forward, so a late
 *  waiting-room signal can never overwrite an active or terminal row. */
const RANK: Record<CaptureStatus, number> = {
  joining: 0,
  awaiting_admission: 1,
  active: 2,
  completed: 3,
  partial: 3,
  failed: 3,
  skipped: 3,
};

export type CaptureStatusPost = (status: CaptureStatus, extra?: Partial<MeetingRow>) => Promise<unknown>;

/** Serializes a capture's persisted status writes.
 *
 *  The worker's /status is authoritative; the transcript row is a projection
 *  readers see. Two writes can race: the join layer's onState fires
 *  asynchronously while the session may already be finalizing. Writes here are
 *  chained in call order and only move forward (joining → awaiting_admission →
 *  active → terminal), so a stale update can never land after a newer one.
 *  close() drains what was already queued and refuses everything after; the
 *  caller writes the terminal row once close() settles, so it is always last.
 *  The DB's enforce_meeting_status trigger remains the durable backstop.
 *
 *  A rejected post reaches its caller (the active write still fails the
 *  capture on a live-meeting conflict) but never breaks the chain or close(). */
export class CaptureStatusWriter {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private lastRank = -1;

  constructor(private readonly post: CaptureStatusPost) {}

  publish(status: CaptureStatus, extra?: Partial<MeetingRow>): Promise<void> {
    if (this.closed) return this.chain;
    const rank = RANK[status];
    if (rank <= this.lastRank) return this.chain;
    this.lastRank = rank;
    const next = this.chain.then(() => this.post(status, extra)).then(() => undefined);
    this.chain = next.catch(() => { /* keep the chain alive; the caller decides */ });
    return next;
  }

  /** Refuse new writes and wait for the ones already queued. */
  close(): Promise<void> {
    this.closed = true;
    return this.chain;
  }
}
