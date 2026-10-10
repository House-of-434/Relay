import { z } from "zod";

import { newId } from "./contracts.ts";

/**
 * One-shot deep-research jobs. A research request is a bounded operation
 * with a beginning, a result, and a deliverable — not a scheduling
 * commitment — so it lives here instead of the routine scheduler. No
 * Routine record is created, no schedule ticks, and the calendar (which
 * lists routines, never runs) stays clean.
 *
 * Like connector actions, the card the user sees is display-only: the
 * pending job lives here, keyed by researchId, and the resolve path looks
 * it up instead of trusting anything on the wire.
 *
 * Lifecycle (server-enforced, the client never transitions state):
 *   proposed -> confirmed -> running -> completed | failed | cancelled
 * Terminal run states arrive from the run ledger via finish(); the registry
 * itself only moves jobs forward through propose/confirm/start.
 */

export const RESEARCH_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_THREAD = 10;
const MAX_TITLE = 200;
const MAX_BRIEF = 24_000;

const researchProposalSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  brief: z.string().trim().min(1).max(MAX_BRIEF),
  timeoutMinutes: z.number().int().min(5).max(1_440).optional(),
}).strict();

export type ResearchStatus =
  | "proposed"
  | "confirmed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ResearchJob {
  researchId: string;
  /** Client-supplied idempotency key: resubmits return the live job. */
  idempotencyKey: string | undefined;
  title: string;
  brief: string;
  botId: string;
  threadId: string;
  timeoutMinutes: number | undefined;
  /** What the run is configured to use. The executed report must record
   * the actual provider (and any fallback) in its methodology section. */
  requestedProvider: "tinyfish";
  status: ResearchStatus;
  runId: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export class ResearchJobError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ResearchJobError";
    this.status = status;
  }
}

export function researchDisplay(job: ResearchJob): { title: string; subtitle: string; detail: string } {
  const plan = job.brief.length > MAX_DISPLAY_BRIEF
    ? `${job.brief.slice(0, MAX_DISPLAY_BRIEF)}\n\n…(truncated for display; the run uses the full brief)`
    : job.brief;
  return {
    title: "Confirm deep research",
    subtitle: job.title,
    detail: `${plan}\n\nConfirming runs this investigation once and delivers a cited report. Nothing is scheduled.`,
  };
}
const MAX_DISPLAY_BRIEF = 2_000;

/** Pending jobs, server-side only. A researchId that is missing, expired,
 * or already consumed resolves to nothing, so a stale or replayed card can
 * never start execution. */
export class PendingResearchJobs {
  private readonly jobs = new Map<string, ResearchJob>();
  /** What a consumed request already did. A repeated tap on Confirm must
   * return this instead of falling through to a generic resolver. */
  private readonly settled = new Map<string, { outcome: string; runId: string | undefined }>();
  private readonly settledAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  submit(args: {
    title: unknown;
    brief: unknown;
    timeoutMinutes?: unknown;
    idempotencyKey?: unknown;
    botId: string;
    threadId: string;
  }): ResearchJob {
    const parsed = researchProposalSchema.safeParse({
      title: args.title,
      brief: args.brief,
      timeoutMinutes: args.timeoutMinutes,
    });
    if (!parsed.success) throw new ResearchJobError("invalid research proposal", 400);
    const key = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
      ? args.idempotencyKey.trim().slice(0, 128)
      : undefined;

    this.evictExpired();
    const live = [...this.jobs.values()].filter((job) => job.threadId === args.threadId);
    // An idempotent resubmit is not new work: return the live job.
    if (key) {
      const existing = live.find((job) =>
        job.idempotencyKey === key && ["proposed", "confirmed", "running"].includes(job.status));
      if (existing) return existing;
    }
    if (live.filter((job) => job.status === "proposed").length >= MAX_PENDING_PER_THREAD) {
      throw new ResearchJobError("too many pending research proposals on this conversation", 429);
    }

    const job: ResearchJob = {
      researchId: newId(),
      idempotencyKey: key,
      title: parsed.data.title,
      brief: parsed.data.brief,
      botId: args.botId,
      threadId: args.threadId,
      timeoutMinutes: parsed.data.timeoutMinutes,
      requestedProvider: "tinyfish",
      status: "proposed",
      runId: undefined,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.jobs.set(job.researchId, job);
    return job;
  }

  peek(researchId: string): ResearchJob | undefined {
    this.evictExpired();
    return this.jobs.get(researchId);
  }

  /** proposed -> confirmed. Idempotent: confirming an already-confirmed job
   * returns it unchanged and never creates follow-on work. */
  confirm(researchId: string): ResearchJob | undefined {
    this.evictExpired();
    const job = this.jobs.get(researchId);
    if (!job || job.status === "cancelled") return undefined;
    if (job.status !== "proposed" && job.status !== "confirmed") return undefined;
    job.status = "confirmed";
    job.updatedAt = this.now();
    return job;
  }

  /** confirmed -> running. Consume-once: only the first start attaches a
   * run; every later call returns undefined so a retry or double-tap can
   * never launch duplicate execution. */
  start(researchId: string, runId: string): ResearchJob | undefined {
    this.evictExpired();
    const job = this.jobs.get(researchId);
    if (!job || job.status !== "confirmed") return undefined;
    job.status = "running";
    job.runId = runId;
    job.updatedAt = this.now();
    return job;
  }

  /** running -> completed | failed | cancelled. Called from the run ledger's
   * completion path; unknown or already-terminal jobs resolve to nothing. */
  finish(researchId: string, outcome: "completed" | "failed" | "cancelled"): ResearchJob | undefined {
    this.evictExpired();
    const job = this.jobs.get(researchId);
    if (!job || job.status !== "running") return undefined;
    job.status = outcome;
    job.updatedAt = this.now();
    this.settle(researchId, outcome, job.runId);
    return job;
  }

  /** proposed | confirmed -> cancelled. The user declined the card. */
  cancel(researchId: string): ResearchJob | undefined {
    this.evictExpired();
    const job = this.jobs.get(researchId);
    if (!job || (job.status !== "proposed" && job.status !== "confirmed")) return undefined;
    job.status = "cancelled";
    job.updatedAt = this.now();
    this.settle(researchId, "cancelled", undefined);
    return job;
  }

  /** Record the outcome of a consumed request, so an identical repeat is
   * answered from history instead of being treated as a stranger's request. */
  settle(researchId: string, outcome: string, runId: string | undefined): void {
    this.settled.set(researchId, { outcome, runId });
    this.settledAt.set(researchId, this.now());
  }

  settledOutcome(researchId: string): { outcome: string; runId: string | undefined } | undefined {
    this.evictExpired();
    return this.settled.get(researchId);
  }

  private evictExpired(): void {
    const cutoff = this.now() - RESEARCH_JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt <= cutoff && job.status !== "running") this.jobs.delete(id);
    }
    // Keep a consumed request replayable a little longer than it was open.
    const replayCutoff = this.now() - RESEARCH_JOB_TTL_MS * 2;
    for (const [id] of this.settled) {
      if (!this.jobs.has(id)) {
        const at = this.settledAt.get(id);
        if (at !== undefined && at <= replayCutoff) {
          this.settled.delete(id);
          this.settledAt.delete(id);
        }
      }
    }
  }
}
