import { describe, expect, it } from "vitest";

import {
  researchFramesActive,
  settleResearchFrame,
  startResearchFrames,
  stopResearchFrames,
  type ResearchFrame,
} from "./research-frames.ts";

const FRAME_A: ResearchFrame = { png: "aGVsbG8=", mime: "image/png" };
const FRAME_B: ResearchFrame = { png: "d29ybGQ=", mime: "image/png" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("research frames", () => {
  it("broadcasts fresh frames and dedupes repeats", async () => {
    const seen: ResearchFrame[] = [];
    let current = FRAME_A;
    startResearchFrames(
      "bot-1",
      "thread-1",
      async () => current,
      (message) => {
        seen.push({ png: message.png, mime: message.mime });
      },
      10,
    );
    try {
      expect(researchFramesActive("thread-1")).toBe(true);
      await sleep(45);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const first = seen.length;
      current = FRAME_B;
      await sleep(35);
      expect(seen.length).toBeGreaterThan(first);
      expect(seen.at(-1)).toEqual(FRAME_B);
    } finally {
      stopResearchFrames("thread-1");
    }
    expect(researchFramesActive("thread-1")).toBe(false);
  });

  it("ignores a second start for the same thread", () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return FRAME_A;
    };
    startResearchFrames("bot-1", "thread-2", fetch, () => {}, 10);
    startResearchFrames("bot-1", "thread-2", fetch, () => {}, 10);
    stopResearchFrames("thread-2");
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("settles a fresh frame only when it is news", async () => {
    startResearchFrames("bot-3", "thread-3", async () => FRAME_A, () => {});
    const settled = await settleResearchFrame("thread-3", undefined);
    expect(settled).toEqual(FRAME_A);
    const { screenFrameHash } = await import("./screen-frame-gate.ts");
    startResearchFrames("bot-3", "thread-3b", async () => FRAME_A, () => {});
    const repeat = await settleResearchFrame("thread-3b", screenFrameHash(FRAME_A.png));
    expect(repeat).toBe(null);
  });

  it("settles nothing when the page is gone", async () => {
    startResearchFrames("bot-4", "thread-4", async () => {
      throw new Error("no page open");
    }, () => {});
    const settled = await settleResearchFrame("thread-4", undefined);
    expect(settled).toBe(null);
    expect(researchFramesActive("thread-4")).toBe(false);
  });

  it("settles nothing without a running poller", async () => {
    const settled = await settleResearchFrame("thread-never", undefined);
    expect(settled).toBe(null);
  });
});
