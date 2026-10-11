import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

export interface ScribeSegment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

export interface ScribeFixture {
  provenance: {
    platform: string;
    capturedAt: string;
    recorder: string;
    stt: string;
    capture: string;
    redaction: string;
    knownErrors: string[];
  };
  segments: ScribeSegment[];
}

/** The first real Scribe capture (Meet, authenticated). A hand-checkable
 * reference for the STT head-to-head and an ingest-shape fixture. */
export function loadScribeFixture(): ScribeFixture {
  return JSON.parse(
    readFileSync(join(ROOT, "..", "fixtures", "scribe", "meet-first-capture.json"), "utf8"),
  ) as ScribeFixture;
}
