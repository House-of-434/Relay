import assert from "node:assert/strict";
import test from "node:test";

import {
  attributeSegment,
  splitAtTransitions,
  type ChunkSpan,
  type HintInterval,
} from "./teams-attribution.js";

const hint = (names: string[], fromMs: number, toMs: number): HintInterval => ({ names, fromMs, toMs });

test("one speaker across the whole slice names the slice", () => {
  const result = attributeSegment([hint(["Micheal"], 0, 6000)], 0, 6000);
  assert.equal(result.speaker, "Micheal");
  assert.equal(result.reason, "speaker");
});

test("a handoff inside a slice is split, and each half gets its own name", () => {
  const intervals = [hint(["Pranam"], 0, 6000), hint(["Micheal"], 6000, 14_000)];
  const chunk: ChunkSpan = { fromMs: 0, toMs: 12_000, count: 12_000 * 16, sampleRate: 16_000 };
  const slices = splitAtTransitions(chunk, [6000]);
  assert.equal(slices.length, 2);

  assert.equal(attributeSegment(intervals, slices[0]!.fromMs, slices[0]!.toMs).speaker, "Pranam");
  assert.equal(attributeSegment(intervals, slices[1]!.fromMs, slices[1]!.toMs).speaker, "Micheal");
});

test("two lit names covering the slice is ambiguous, never a pick", () => {
  const result = attributeSegment([hint(["Pranam", "Micheal"], 0, 6000)], 0, 6000);
  assert.equal(result.speaker, null);
  assert.equal(result.reason, "ambiguous");
});

test("a brief overlap does not veto an otherwise clear speaker", () => {
  // 5s clearly Micheal, 1s overlap: still Micheal.
  const result = attributeSegment(
    [hint(["Micheal"], 0, 5000), hint(["Micheal", "Pranam"], 5000, 6000)],
    0,
    6000,
  );
  assert.equal(result.speaker, "Micheal");
});

test("insufficient coverage against the full slice duration is refused", () => {
  // Only 1s of evidence inside a 6s slice: 0.17 coverage.
  const result = attributeSegment([hint(["Pranam"], 1000, 2000), hint([], 2000, 6000)], 0, 6000);
  assert.equal(result.speaker, null);
  assert.equal(result.reason, "insufficient-coverage");
});

test("a stale lit tile does not keep naming a silent slice", () => {
  // Lit for 2s, then nobody detected for 8s.
  const result = attributeSegment([hint(["Pranam"], 0, 2000), hint([], 2000, 10_000)], 0, 10_000);
  assert.equal(result.speaker, null);
  assert.ok(result.coverage.Pranam === 2000);
  assert.equal(result.unknownMs, 8000);
});

test("no hints at all is refused without throwing", () => {
  const result = attributeSegment([], 0, 6000);
  assert.equal(result.speaker, null);
  assert.equal(result.reason, "no-hints");
});

test("a near-tie between two names is refused", () => {
  // With disjoint intervals and the default 0.75 floor the coverage rule already
  // rejects this; exercise the margin rule directly at a lower floor so the
  // rule is proven rather than shadowed.
  const result = attributeSegment(
    [hint(["A"], 0, 3000), hint(["B"], 3000, 5500)],
    100,
    5600,
    { minCoverage: 0.5 },
  );
  assert.equal(result.speaker, null);
  assert.equal(result.reason, "too-close");
});

test("an empty slice is refused", () => {
  assert.equal(attributeSegment([hint(["A"], 0, 1000)], 1000, 1000).reason, "empty-slice");
});

test("split ignores transitions too close to an edge or to each other", () => {
  const chunk: ChunkSpan = { fromMs: 0, toMs: 10_000, count: 10_000 * 16, sampleRate: 16_000 };
  const slices = splitAtTransitions(chunk, [500, 3800, 4000, 9800], { minSliceMs: 2000 });
  // 500 dropped (< 2s from the edge), 4000 dropped (400ms after 3800),
  // 9800 dropped (< 2s from the end). 3800 survives.
  assert.deepEqual(slices.map((s) => [s.fromMs, s.toMs]), [[0, 3800], [3800, 10_000]]);
});

test("sample offsets match the chunk clock and never exceed the drained count", () => {
  const chunk: ChunkSpan = { fromMs: 1000, toMs: 5000, count: 4 * 16_000, sampleRate: 16_000 };
  const slices = splitAtTransitions(chunk, [3000], { minSliceMs: 500 });
  assert.equal(slices.length, 2);
  assert.equal(slices[0]!.startSample, 0);
  assert.equal(slices[0]!.endSample, 32_000);
  assert.equal(slices[1]!.startSample, 32_000);
  assert.equal(slices[1]!.endSample, 64_000);
});

test("a long slice with no transition is capped at maxSliceMs", () => {
  const chunk: ChunkSpan = { fromMs: 0, toMs: 20_000, count: 20_000 * 16, sampleRate: 16_000 };
  const slices = splitAtTransitions(chunk, [], { maxSliceMs: 8000 });
  assert.equal(slices.length, 3);
  for (const slice of slices) assert.ok(slice.toMs - slice.fromMs <= 8000 + 1);
  // Contiguous and complete.
  assert.equal(slices[0]!.fromMs, 0);
  assert.equal(slices[slices.length - 1]!.toMs, 20_000);
});

test("a degenerate chunk produces no slices", () => {
  assert.deepEqual(splitAtTransitions({ fromMs: 0, toMs: 0, count: 0, sampleRate: 16_000 }, []), []);
});
