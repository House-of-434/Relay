import assert from "node:assert/strict";
import test from "node:test";

import { SegmentSpool } from "./spool.js";
import type { Segment } from "./types.js";

const seg = (i: number): Segment => ({ segment_key: `turn:${i}`, speaker: null, start_seconds: i, end_seconds: i + 1, text: `s${i}` });

test("flushes when the segment count is reached", () => {
  const spool = new SegmentSpool(3, 60_000, 0);
  spool.add(seg(1));
  spool.add(seg(2));
  assert.equal(spool.shouldFlush(10), false);
  spool.add(seg(3));
  assert.equal(spool.shouldFlush(10), true);
  assert.equal(spool.drain(10).length, 3);
  assert.equal(spool.pending, 0);
});

test("flushes on elapsed time even below the segment count", () => {
  const spool = new SegmentSpool(50, 17_500, 0);
  spool.add(seg(1));
  assert.equal(spool.shouldFlush(17_499), false);
  assert.equal(spool.shouldFlush(17_500), true);
  assert.equal(spool.drain(17_500).length, 1);
});

test("drain resets the timer and never returns empty when nothing is due", () => {
  const spool = new SegmentSpool(50, 17_500, 0);
  assert.deepEqual(spool.drain(1_000), []);
  spool.add(seg(1));
  assert.equal(spool.drain(1_000).length, 1);
  // next flush window starts at the drain time (1000)
  spool.add(seg(2));
  assert.equal(spool.shouldFlush(18_499), false);
  assert.equal(spool.shouldFlush(18_500), true);
});

test("tracks added and flushed totals", () => {
  const spool = new SegmentSpool(2, 60_000, 0);
  spool.add(seg(1));
  spool.add(seg(2));
  spool.drain(0);
  spool.add(seg(3));
  assert.equal(spool.added, 3);
  assert.equal(spool.flushed, 2);
  assert.equal(spool.pending, 1);
});
