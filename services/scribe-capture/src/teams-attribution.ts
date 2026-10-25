/** Teams attribution — pure logic, no browser, no timers.
 *
 * Teams gives one mixed audio track. The page gives a timeline of who appeared
 * to be speaking (`teams-hints.ts`). This module is the join between them: given
 * a transcript slice's audio-time range and the hint intervals covering the same
 * clock, decide the speaker — or refuse.
 *
 * Deliberate properties:
 * - Coverage is measured against the slice's FULL duration, so a winner that
 *   only covers the observed part of a mostly-silent slice is still rejected.
 * - Two lit names is ambiguity, never an arbitrary pick.
 * - A wrong name is worse than none: every failure path returns null.
 */

export interface HintInterval {
  /** Distinct names lit during the interval; empty means nobody detected. */
  names: string[];
  fromMs: number;
  toMs: number;
}

export interface AttributionOptions {
  /** Share of the slice's full duration the winner must cover. */
  minCoverage?: number;
  /** Winner must cover at least this multiple of the runner-up. */
  margin?: number;
  /** Refuse to name when ambiguous (2+ lit) coverage exceeds this share. */
  maxAmbiguousShare?: number;
}

export type AttributionReason =
  | "speaker"
  | "empty-slice"
  | "no-hints"
  | "ambiguous"
  | "insufficient-coverage"
  | "too-close";

export interface Attribution {
  speaker: string | null;
  reason: AttributionReason;
  /** Milliseconds covered per name, for diagnostics and tests. */
  coverage: Record<string, number>;
  durationMs: number;
  ambiguousMs: number;
  unknownMs: number;
}

interface Tally {
  perName: Map<string, number>;
  ambiguousMs: number;
  unknownMs: number;
  sawInterval: boolean;
}

function tallyIntervals(intervals: readonly HintInterval[], fromMs: number, toMs: number): Tally {
  const perName = new Map<string, number>();
  let ambiguousMs = 0;
  let unknownMs = 0;
  let sawInterval = false;
  for (const interval of intervals) {
    const start = Math.max(interval.fromMs, fromMs);
    const end = Math.min(interval.toMs, toMs);
    if (end <= start) continue;
    const covered = end - start;
    sawInterval = true;
    if (interval.names.length === 0) {
      unknownMs += covered;
    } else if (interval.names.length > 1) {
      ambiguousMs += covered;
    } else {
      const name = interval.names[0]!;
      perName.set(name, (perName.get(name) ?? 0) + covered);
    }
  }
  return { perName, ambiguousMs, unknownMs, sawInterval };
}

export function attributeSegment(
  intervals: readonly HintInterval[],
  segFromMs: number,
  segToMs: number,
  options: AttributionOptions = {},
): Attribution {
  const minCoverage = options.minCoverage ?? 0.75;
  const margin = options.margin ?? 2;
  const maxAmbiguousShare = options.maxAmbiguousShare ?? 0.5;

  const durationMs = segToMs - segFromMs;
  const coverage: Record<string, number> = {};
  if (!(durationMs > 0)) {
    return { speaker: null, reason: "empty-slice", coverage, durationMs, ambiguousMs: 0, unknownMs: 0 };
  }

  const { perName, ambiguousMs, unknownMs, sawInterval } = tallyIntervals(intervals, segFromMs, segToMs);
  for (const [name, ms] of perName) coverage[name] = ms;

  if (!sawInterval) {
    return { speaker: null, reason: "no-hints", coverage, durationMs, ambiguousMs, unknownMs };
  }
  // Overlap or a transition in flight owns this slice: say nothing.
  if (ambiguousMs / durationMs > maxAmbiguousShare) {
    return { speaker: null, reason: "ambiguous", coverage, durationMs, ambiguousMs, unknownMs };
  }

  let winner: string | null = null;
  let winnerMs = 0;
  let runnerUpMs = 0;
  for (const [name, ms] of perName) {
    if (ms > winnerMs) {
      runnerUpMs = winnerMs;
      winner = name;
      winnerMs = ms;
    } else if (ms > runnerUpMs) {
      runnerUpMs = ms;
    }
  }

  if (!winner || winnerMs / durationMs < minCoverage) {
    return { speaker: null, reason: "insufficient-coverage", coverage, durationMs, ambiguousMs, unknownMs };
  }
  if (runnerUpMs > 0 && winnerMs < margin * runnerUpMs) {
    return { speaker: null, reason: "too-close", coverage, durationMs, ambiguousMs, unknownMs };
  }
  return { speaker: winner, reason: "speaker", coverage, durationMs, ambiguousMs, unknownMs };
}

/** A chunk of drained audio and its audio-clock range. */
export interface ChunkSpan {
  fromMs: number;
  toMs: number;
  /** Samples actually accepted by the tap. */
  count: number;
  sampleRate: number;
}

export interface AudioSlice {
  fromMs: number;
  toMs: number;
  startSample: number;
  endSample: number;
}

export interface SplitOptions {
  /** Slices shorter than this are not worth an STT call; boundaries closer than
   *  this to an edge or to each other are dropped. */
  minSliceMs?: number;
  /** Hard cap on one STT request even when no transition splits it. */
  maxSliceMs?: number;
}

/**
 * Cut a drained chunk at confirmed speaker transitions.
 *
 * Only transitions strictly inside the chunk count; a boundary too close to an
 * edge or to another boundary is ignored (a 300ms sliver transcribes worse than
 * the few words it might separate). Any slice still longer than `maxSliceMs` is
 * split evenly, so a quiet meeting cannot grow unbounded audio between drains.
 */
export function splitAtTransitions(
  chunk: ChunkSpan,
  transitionsMs: readonly number[],
  options: SplitOptions = {},
): AudioSlice[] {
  const minSliceMs = options.minSliceMs ?? 2000;
  const maxSliceMs = options.maxSliceMs ?? 8000;
  const rate = chunk.sampleRate > 0 ? chunk.sampleRate : 16_000;
  const durationMs = chunk.toMs - chunk.fromMs;
  if (!(durationMs > 0) || chunk.count <= 0) return [];

  const boundaries: number[] = [chunk.fromMs];
  const candidates = [...transitionsMs].sort((a, b) => a - b);
  let last = chunk.fromMs;
  for (const t of candidates) {
    if (t - chunk.fromMs < minSliceMs) continue;
    if (chunk.toMs - t < minSliceMs) continue;
    if (t - last < minSliceMs) continue;
    boundaries.push(t);
    last = t;
  }
  boundaries.push(chunk.toMs);

  const adjacent: Array<{ fromMs: number; toMs: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    adjacent.push({ fromMs: boundaries[i]!, toMs: boundaries[i + 1]! });
  }

  const pieces: Array<{ fromMs: number; toMs: number }> = [];
  for (const span of adjacent) {
    const ms = span.toMs - span.fromMs;
    const parts = Math.max(1, Math.ceil(ms / maxSliceMs));
    const step = ms / parts;
    for (let i = 0; i < parts; i++) {
      pieces.push({ fromMs: span.fromMs + i * step, toMs: span.fromMs + (i + 1) * step });
    }
  }

  const slices: AudioSlice[] = [];
  for (const piece of pieces) {
    const startSample = Math.max(0, Math.min(chunk.count, Math.round(((piece.fromMs - chunk.fromMs) / 1000) * rate)));
    const endSample = Math.max(0, Math.min(chunk.count, Math.round(((piece.toMs - chunk.fromMs) / 1000) * rate)));
    if (endSample - startSample <= 0) continue;
    slices.push({ fromMs: piece.fromMs, toMs: piece.toMs, startSample, endSample });
  }
  return slices;
}
