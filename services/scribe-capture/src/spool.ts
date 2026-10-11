import type { Segment } from "./types.js";

/** Flush policy: emit when either the buffer reaches `flushSegments` or
 * `flushMs` has elapsed since the last flush, whichever comes first. Pure and
 * clock-injected so it is testable offline. */
export class SegmentSpool {
  private buffer: Segment[] = [];
  private lastFlushMs: number;
  private totalAdded = 0;
  private totalFlushed = 0;

  constructor(
    private readonly flushSegments: number,
    private readonly flushMs: number,
    nowMs: number,
  ) {
    this.lastFlushMs = nowMs;
  }

  add(segment: Segment): void {
    this.buffer.push(segment);
    this.totalAdded += 1;
  }

  /** True when a flush is due (segment count or elapsed time). */
  shouldFlush(nowMs: number): boolean {
    if (this.buffer.length === 0) return false;
    return this.buffer.length >= this.flushSegments || nowMs - this.lastFlushMs >= this.flushMs;
  }

  /** Take the buffered segments and reset the timer. Empty when nothing due. */
  drain(nowMs: number): Segment[] {
    if (this.buffer.length === 0) return [];
    const out = this.buffer;
    this.buffer = [];
    this.lastFlushMs = nowMs;
    this.totalFlushed += out.length;
    return out;
  }

  get pending(): number {
    return this.buffer.length;
  }

  get added(): number {
    return this.totalAdded;
  }

  get flushed(): number {
    return this.totalFlushed;
  }
}
