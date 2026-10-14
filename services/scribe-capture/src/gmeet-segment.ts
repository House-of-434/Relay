import type { Segment } from "./types.js";

/** The vendored gmeet-pipeline's placeholder for an unnamed channel. */
export const GMEET_UNKNOWN = "Speaker";

/** One confirmed segment as the vendored gmeet-pipeline emits it (transcript.v1).
 *  Times are WALL-CLOCK epoch seconds (windowStartMs/1000, per the lane's contract). */
export interface GmeetSegmentLike {
  speaker: string;
  speaker_key?: string;
  text: string;
  start: number;
  end: number;
  language?: string | null;
  confidence?: number;
  source?: string;
}

/** The channel number out of a pipeline speaker_key (`ch-<n>:<turn>`). */
export function channelOf(speakerKey: string | undefined): number {
  const m = /^ch-(\d+)/.exec(speakerKey ?? "");
  return m ? Number(m[1]) : 0;
}

/** Map a pipeline segment to our store Segment. Rebuilds times as
 *  meeting-relative seconds from capture start, and keys the row
 *  `ch<channel>:<start_ms>` so a re-flush upserts the same row. The pipeline's
 *  UNKNOWN label becomes null (rendered "Unknown"). */
export function toSegment(seg: GmeetSegmentLike, captureStartSec: number): Segment {
  const channel = channelOf(seg.speaker_key);
  const epochMs = Math.round(seg.start * 1000);
  return {
    segment_key: `ch${channel}:${epochMs}`,
    speaker: seg.speaker === GMEET_UNKNOWN ? null : seg.speaker,
    channel,
    speaker_key: seg.speaker_key ?? null,
    source: seg.source ?? null,
    start_seconds: Number((seg.start - captureStartSec).toFixed(2)),
    end_seconds: Number((seg.end - captureStartSec).toFixed(2)),
    text: seg.text,
    language: seg.language ?? null,
    confidence: typeof seg.confidence === "number" ? seg.confidence : null,
  };
}
