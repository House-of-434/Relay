import assert from "node:assert/strict";
import test from "node:test";

import { channelOf, toSegment } from "./gmeet-segment.js";

test("channelOf parses the channel from a pipeline speaker_key", () => {
  assert.equal(channelOf("ch-3:2"), 3);
  assert.equal(channelOf("ch-0:1"), 0);
  assert.equal(channelOf(undefined), 0);
  assert.equal(channelOf("provisional"), 0);
});

test("toSegment keys the row ch<channel>:<start_ms> (stable across re-flush)", () => {
  const captureStartSec = 1000;
  const seg = { speaker: "Dana", speaker_key: "ch-3:1", text: "hello", start: 1005.5, end: 1007.5 };
  const a = toSegment(seg, captureStartSec);
  const b = toSegment(seg, captureStartSec); // a re-flush of the same segment
  assert.equal(a.segment_key, "ch3:1005500");
  assert.equal(a.segment_key, b.segment_key);
  assert.equal(a.channel, 3);
  assert.equal(a.speaker_key, "ch-3:1");
  // times become meeting-relative seconds from capture start
  assert.equal(a.start_seconds, 5.5);
  assert.equal(a.end_seconds, 7.5);
});

test("the pipeline's UNKNOWN label becomes null (never a wrong name)", () => {
  const s = toSegment({ speaker: "Speaker", speaker_key: "ch-1:1", text: "hm", start: 10, end: 11 }, 0);
  assert.equal(s.speaker, null);
});

test("a glow-bound name and source are carried through", () => {
  const s = toSegment(
    { speaker: "Dana", speaker_key: "ch-2:4", text: "hi", start: 12, end: 13, source: "glow-bound", confidence: 1, language: "en" },
    0,
  );
  assert.equal(s.speaker, "Dana");
  assert.equal(s.source, "glow-bound");
  assert.equal(s.confidence, 1);
  assert.equal(s.language, "en");
});
