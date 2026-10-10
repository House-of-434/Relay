import { describe, expect, it } from "vitest";

import {
  PendingResearchJobs,
  ResearchJobError,
  researchDisplay,
} from "./research-jobs.ts";

const BOT = "bot-scout";
const THREAD = "thread-1";
const PROPOSAL = {
  title: "Verify Electron claims",
  brief: "Investigate smallest.ai Electron: verify four headline claims with cited sources.",
};

function jobs(now = 1_000_000) {
  let at = now;
  return new PendingResearchJobs(() => at);
}

describe("research job proposals", () => {
  it("rejects invalid proposals without creating jobs", () => {
    const pending = jobs();
    expect(() => pending.submit({ title: "", brief: "b", botId: BOT, threadId: THREAD }))
      .toThrowError(ResearchJobError);
    expect(() => pending.submit({ title: "t", brief: "", botId: BOT, threadId: THREAD }))
      .toThrowError(ResearchJobError);
    expect(() => pending.submit({ title: "t", brief: "b", timeoutMinutes: 2, botId: BOT, threadId: THREAD }))
      .toThrowError(ResearchJobError);
  });

  it("resubmits with the same idempotency key return the live job", () => {
    const pending = jobs();
    const first = pending.submit({ ...PROPOSAL, idempotencyKey: "key-1", botId: BOT, threadId: THREAD });
    const second = pending.submit({ ...PROPOSAL, idempotencyKey: "key-1", botId: BOT, threadId: THREAD });
    expect(second.researchId).toBe(first.researchId);
    expect(first.status).toBe("proposed");
  });

  it("caps pending proposals per thread", () => {
    const pending = jobs();
    for (let i = 0; i < 10; i++) {
      pending.submit({ ...PROPOSAL, title: `job ${i}`, botId: BOT, threadId: THREAD });
    }
    expect(() => pending.submit({ ...PROPOSAL, title: "one more", botId: BOT, threadId: THREAD }))
      .toThrowError(ResearchJobError);
  });
});

describe("research job lifecycle", () => {
  it("enforces proposed -> confirmed -> running -> completed", () => {
    const pending = jobs();
    const job = pending.submit({ ...PROPOSAL, botId: BOT, threadId: THREAD });
    // Cannot start before confirmation.
    expect(pending.start(job.researchId, "run-1")).toBeUndefined();
    expect(pending.confirm(job.researchId)?.status).toBe("confirmed");
    // Confirming again is idempotent, not new work.
    expect(pending.confirm(job.researchId)?.status).toBe("confirmed");
    expect(pending.start(job.researchId, "run-1")?.status).toBe("running");
    // A second start never launches duplicate execution.
    expect(pending.start(job.researchId, "run-2")).toBeUndefined();
    expect(pending.peek(job.researchId)?.runId).toBe("run-1");
    expect(pending.finish(job.researchId, "completed")?.status).toBe("completed");
    expect(pending.finish(job.researchId, "failed")).toBeUndefined();
  });

  it("cancels a proposed job and replays the outcome", () => {
    const pending = jobs();
    const job = pending.submit({ ...PROPOSAL, botId: BOT, threadId: THREAD });
    expect(pending.cancel(job.researchId)?.status).toBe("cancelled");
    expect(pending.confirm(job.researchId)).toBeUndefined();
    expect(pending.settledOutcome(job.researchId)).toEqual({ outcome: "cancelled", runId: undefined });
  });

  it("an unknown researchId resolves to nothing", () => {
    const pending = jobs();
    expect(pending.peek("missing")).toBeUndefined();
    expect(pending.confirm("missing")).toBeUndefined();
    expect(pending.start("missing", "run-1")).toBeUndefined();
    expect(pending.settledOutcome("missing")).toBeUndefined();
  });
});

describe("researchDisplay", () => {
  it("shows the plan preview without scheduling language", () => {
    const pending = jobs();
    const job = pending.submit({ ...PROPOSAL, botId: BOT, threadId: THREAD });
    const display = researchDisplay(job);
    expect(display.title).toMatch(/research/i);
    expect(display.subtitle).toBe(PROPOSAL.title);
    expect(display.detail).toMatch(/once/);
  });
});
