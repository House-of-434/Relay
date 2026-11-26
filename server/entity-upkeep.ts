/** Background capture for the shared company/person directory.
 *
 * One extraction per completed research execution (<threadId>:<latestTurnId>),
 * after a quiet spell. The extracted payloads are persisted BEFORE any write;
 * companies are written first, then their people, and each entity retries
 * independently so a single failure never rolls back the rest. The Tool Layer
 * is still the only writer — this calls relay_write with a signed Scout actor.
 */
import { readFileSync, statSync } from "node:fs";

import {
  capturePrompt,
  captureTranscript,
  companyEntityKey,
  isResearchThread,
  matchCompanyKey,
  parseCapture,
  personEntityKey,
  type CaptureAttachment,
  type CaptureMessage,
  type CapturedCompany,
  type CapturedPerson,
} from "./entity-capture.ts";
import type { EntityCaptureJob, EntityCaptureJobStatus, EntityCaptureRun, EntityCaptureStatus } from "./message-db.ts";

export const CAPTURE_RUN_MAX_ATTEMPTS = 3;
export const CAPTURE_JOB_MAX_ATTEMPTS = 5;
export const CAPTURE_BACKOFF_BASE_MS = 60_000;
export const CAPTURE_BACKOFF_MAX_MS = 60 * 60_000;
export const CAPTURE_TICK_MS = 30_000;
// A full deep-research report is a long prompt; Claude's one-shot review ran
// ~100s on a 20k-character attachment, so 60s killed a valid extraction.
export const CAPTURE_MODEL_TIMEOUT_MS = 180_000;
const CAPTURE_REVIEW_TIMEOUT_MS = CAPTURE_MODEL_TIMEOUT_MS - 10_000;

const TERMINAL_FAILURE =
  /(invalid|unknown column|must be|not allowed|forbidden|unauthorized|authenticated actor|classification|source_url|confidence|unknown tool|could not be signed|capture has no owner)/i;

const TEXT_ATTACHMENT = /\.(md|markdown|txt|csv|tsv|json)$/i;
const MAX_ATTACHMENT_BYTES = 256 * 1024;

/** Deep research attaches its full sourced report as a markdown file and
 *  leaves only a summary in chat. Read small text attachments so extraction
 *  sees the per-entity source URLs; images, audio, and binary documents stay
 *  out of the model prompt. */
function readTextAttachment(attachment: CaptureAttachment): string | null {
  if (attachment.kind !== "file" || !attachment.path) return null;
  const mime = attachment.mime ?? "";
  if (!mime.startsWith("text/") && mime !== "application/json" && !TEXT_ATTACHMENT.test(attachment.name ?? "")) {
    return null;
  }
  try {
    const info = statSync(attachment.path);
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return null;
    return readFileSync(attachment.path, "utf8");
  } catch {
    return null;
  }
}

export interface EntityUpkeepBot {
  id: string;
  name: string;
  ownerUserId?: string | null;
  relayAgent?: string | null;
}

export interface EntityUpkeepEngine {
  generateText?: (prompt: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;
}

export interface EntityUpkeepStore {
  createRun(run: EntityCaptureRun): boolean;
  getRun(executionKey: string): EntityCaptureRun | null;
  updateRun(executionKey: string, patch: {
    status?: EntityCaptureStatus;
    attempts?: number;
    lastError?: string | null;
    nextAttemptAt?: number;
    updatedAt: number;
  }): void;
  dueRuns(now: number, limit?: number): EntityCaptureRun[];
  createJobs(executionKey: string, jobs: readonly EntityCaptureJob[]): void;
  listJobs(executionKey: string): EntityCaptureJob[];
  updateJob(executionKey: string, entityKey: string, patch: {
    status?: EntityCaptureJobStatus;
    resultId?: string | null;
    resultStatus?: string | null;
    attempts?: number;
    lastError?: string | null;
    nextAttemptAt?: number;
    updatedAt: number;
  }): void;
}

export interface EntityUpkeepDeps {
  store: EntityUpkeepStore;
  enabled: () => boolean;
  bot: (id: string) => EntityUpkeepBot | undefined;
  botByThread: (threadId: string) => EntityUpkeepBot | undefined;
  /** False for group rooms, harness/internal turns, and unattended runs. */
  eligibleThread?: (threadId: string, botId: string) => boolean;
  engine: (botId: string) => EntityUpkeepEngine | null;
  threadMessages: (threadId: string) => readonly CaptureMessage[];
  isResearchExecutionThread: (threadId: string) => boolean;
  quietMs: () => number;
  signActor: (actor: { userId: string; botId: string; threadId: string; agent: "scout" | "mercury" }) => string | null;
  runTool: (input: {
    agent: "scout" | "mercury";
    assertion: string;
    tool: string;
    args: Record<string, unknown>;
  }) => Promise<{ ok: boolean; text: string }>;
  now?: () => number;
  log?: (line: string) => void;
  budget?: () => void;
  today?: () => string;
}

export interface EntityUpkeep {
  /** A finished turn. Queues only research activity (or a dedicated research
   *  thread), keyed by the turn so later research in the same thread counts. */
  noteTurn(threadId: string, turnId: string): void;
  /** Flush a due thread now; exposed for tests and an eager drain. */
  flushThread(threadId: string): Promise<void>;
  /** Process due quiet windows, extraction runs, and retries. */
  tick(now?: number): Promise<void>;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Wait for captures in flight (tests, shutdown). */
  idle(): Promise<void>;
}

interface PendingCapture {
  turnId: string;
  botId: string;
  agent: "scout" | "mercury";
  dueAt: number;
}

function backoff(attempts: number): number {
  return Math.min(CAPTURE_BACKOFF_MAX_MS, CAPTURE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function isTerminalEntityFailure(text: string): boolean {
  return TERMINAL_FAILURE.test(text);
}

function resultOf(text: string): { status?: string; id?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.id === "string" ? { id: record.id } : {}),
    };
  } catch {
    return null;
  }
}

function companyData(company: CapturedCompany, observedAt: string): Record<string, unknown> {
  return {
    name: company.name,
    domains: company.domains,
    ...(company.description !== undefined ? { description: company.description } : {}),
    ...(company.location !== undefined ? { location: company.location } : {}),
    ...(company.employee_count !== undefined ? { employee_count: company.employee_count } : {}),
    ...(company.industry !== undefined ? { industry: company.industry } : {}),
    ...(company.vertical !== undefined ? { vertical: company.vertical } : {}),
    ...(company.technology !== undefined ? { technology: company.technology } : {}),
    ...(company.stage !== undefined ? { stage: company.stage } : {}),
    ...(company.company_type !== undefined ? { company_type: company.company_type } : {}),
    ...(company.domain_expertise !== undefined ? { domain_expertise: company.domain_expertise } : {}),
    ...(company.linkedin_url !== undefined ? { linkedin_url: company.linkedin_url } : {}),
    ...(company.website !== undefined ? { website: company.website } : {}),
    source: "research",
    source_url: company.source_url,
    observed_at: observedAt,
    confidence: company.confidence,
  };
}

function personData(person: CapturedPerson, observedAt: string, companyId: string | null): Record<string, unknown> {
  return {
    full_name: person.full_name,
    ...(person.aliases !== undefined ? { aliases: person.aliases } : {}),
    ...(person.person_type !== undefined ? { person_type: person.person_type } : {}),
    ...(companyId ? { company_id: companyId } : {}),
    // A resolver hint, not a column: the Tool Layer links an existing company
    // when the employer was not part of this extraction batch.
    ...(person.company !== undefined ? { company: person.company } : {}),
    ...(person.title !== undefined ? { title: person.title } : {}),
    ...(person.location !== undefined ? { location: person.location } : {}),
    ...(person.linkedin_url !== undefined ? { linkedin_url: person.linkedin_url } : {}),
    ...(person.bio !== undefined ? { bio: person.bio } : {}),
    ...(person.education !== undefined ? { education: person.education } : {}),
    ...(person.links !== undefined ? { links: person.links } : {}),
    source: "research",
    source_url: person.source_url,
    observed_at: observedAt,
    confidence: person.confidence,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("the extraction call timed out"));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createEntityUpkeep(deps: EntityUpkeepDeps): EntityUpkeep {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const pending = new Map<string, PendingCapture>();
  const inFlight = new Set<string>();
  const tracked = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let ticking = false;

  function track(promise: Promise<void>): Promise<void> {
    tracked.add(promise);
    void promise.finally(() => tracked.delete(promise));
    return promise;
  }

  function failRun(executionKey: string, error: unknown, at: number): void {
    const run = deps.store.getRun(executionKey);
    if (!run || run.status === "done" || run.status === "failed") return;
    const message = error instanceof Error ? error.message.slice(0, 300) : "capture failed";
    const attempts = run.attempts + 1;
    if (attempts >= CAPTURE_RUN_MAX_ATTEMPTS) {
      deps.store.updateRun(executionKey, { status: "failed", attempts, lastError: message, updatedAt: at });
      log(`entity capture: ${executionKey} failed after ${attempts} attempts: ${message}`);
      return;
    }
    deps.store.updateRun(executionKey, {
      status: "pending",
      attempts,
      lastError: message,
      nextAttemptAt: at + backoff(attempts),
      updatedAt: at,
    });
  }

  async function extract(run: EntityCaptureRun, at: number): Promise<void> {
    const messages = deps.threadMessages(run.threadId);
    const { report, activity } = captureTranscript(messages, run.turnId, readTextAttachment);
    if (!report.trim() && !activity.trim()) {
      deps.store.updateRun(run.executionKey, { status: "done", lastError: null, updatedAt: at });
      return;
    }

    const engine = deps.engine(run.botId);
    if (!engine?.generateText) {
      deps.store.updateRun(run.executionKey, {
        status: "failed",
        lastError: "the research bot has no text engine",
        updatedAt: at,
      });
      log(`entity capture: ${run.executionKey} skipped, the research bot has no text engine`);
      return;
    }

    deps.budget?.();
    const controller = new AbortController();
    const prompt = capturePrompt({
      today: deps.today?.() ?? new Date(at).toISOString().slice(0, 10),
      // The bot's sourced report and activity only: the person's own turn can
      // carry confidential context and is not needed to extract entities.
      report,
      activity,
    });
    const raw = await withTimeout(
      engine.generateText(prompt, { signal: controller.signal, timeoutMs: CAPTURE_REVIEW_TIMEOUT_MS }),
      CAPTURE_MODEL_TIMEOUT_MS,
      controller,
    );
    const entities = parseCapture(raw);
    const observedAt = new Date(at).toISOString();
    const jobs: EntityCaptureJob[] = [];
    const jobKeys = new Set<string>();

    for (const company of entities.companies) {
      const entityKey = companyEntityKey(company);
      if (jobKeys.has(entityKey)) continue;
      jobKeys.add(entityKey);
      jobs.push({
        executionKey: run.executionKey,
        entityKey,
        kind: "company",
        companyKey: null,
        payload: companyData(company, observedAt),
        status: "pending",
        resultId: null,
        resultStatus: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }

    for (const person of entities.people) {
      const companyKey = matchCompanyKey(person.company, entities.companies);
      const entityKey = personEntityKey(person, companyKey);
      if (jobKeys.has(entityKey)) continue;
      jobKeys.add(entityKey);
      jobs.push({
        executionKey: run.executionKey,
        entityKey,
        kind: "person",
        companyKey,
        payload: personData(person, observedAt, null),
        status: "pending",
        resultId: null,
        resultStatus: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }

    if (jobs.length > 0) deps.store.createJobs(run.executionKey, jobs);
    deps.store.updateRun(run.executionKey, {
      status: jobs.length > 0 ? "processing" : "done",
      attempts: 0,
      lastError: null,
      nextAttemptAt: 0,
      updatedAt: at,
    });
    log(`entity capture: ${run.executionKey} extracted ${entities.companies.length} company and ${entities.people.length} person entit${entities.people.length === 1 ? "y" : "ies"}`);
  }

  async function writeEntity(
    run: EntityCaptureRun,
    table: "app.companies" | "app.people",
    data: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    const bot = deps.bot(run.botId);
    if (!bot?.ownerUserId) return { ok: false, text: "the capture has no owner to sign for" };
    const agent = run.agent === "mercury" ? "mercury" : "scout";
    const assertion = deps.signActor({ userId: bot.ownerUserId, botId: run.botId, threadId: run.threadId, agent });
    if (!assertion) return { ok: false, text: "the entity write could not be signed" };
    return deps.runTool({
      agent,
      assertion,
      tool: "relay_write",
      args: { table, operation: "insert", data },
    });
  }

  function finishJob(
    run: EntityCaptureRun,
    job: EntityCaptureJob,
    patch: { status: EntityCaptureJobStatus; resultId?: string | null; resultStatus?: string | null; attempts?: number; lastError?: string | null; nextAttemptAt?: number },
    at: number,
  ): void {
    deps.store.updateJob(run.executionKey, job.entityKey, { ...patch, updatedAt: at });
  }

  async function writeJobs(run: EntityCaptureRun, at: number): Promise<void> {
    const jobs = deps.store.listJobs(run.executionKey);
    const companyStates = new Map<string, { status: EntityCaptureJobStatus; resultId: string | null }>();
    for (const job of jobs) {
      if (job.kind === "company") companyStates.set(job.entityKey, { status: job.status, resultId: job.resultId });
    }

    for (const job of jobs) {
      if (job.status !== "pending" || job.nextAttemptAt > at) continue;
      let companyId: string | null = null;
      if (job.kind === "person" && job.companyKey) {
        const company = companyStates.get(job.companyKey);
        if (company?.status === "pending") continue; // company first
        if (company?.status === "done") companyId = company.resultId;
      }

      const data = job.kind === "person"
        ? { ...job.payload, ...(companyId ? { company_id: companyId } : {}) }
        : job.payload;

      let outcome: { ok: boolean; text: string };
      try {
        outcome = await writeEntity(run, job.kind === "company" ? "app.companies" : "app.people", data);
      } catch (error) {
        outcome = { ok: false, text: error instanceof Error ? error.message : "the entity write failed" };
      }

      if (outcome.ok) {
        const result = resultOf(outcome.text);
        const resultId = result?.id ?? null;
        if (job.kind === "company") companyStates.set(job.entityKey, { status: "done", resultId });
        finishJob(run, job, {
          status: "done",
          resultId,
          resultStatus: result?.status ?? "done",
          attempts: job.attempts,
          lastError: null,
          nextAttemptAt: 0,
        }, at);
        continue;
      }

      const attempts = job.attempts + 1;
      if (isTerminalEntityFailure(outcome.text) || attempts >= CAPTURE_JOB_MAX_ATTEMPTS) {
        finishJob(run, job, {
          status: "failed",
          attempts,
          lastError: outcome.text.slice(0, 300) || "the entity write was refused",
          nextAttemptAt: 0,
        }, at);
        log(`entity capture: ${run.executionKey} ${job.kind} ${job.entityKey} failed: ${outcome.text.slice(0, 160)}`);
        continue;
      }
      finishJob(run, job, {
        status: "pending",
        attempts,
        lastError: outcome.text.slice(0, 300),
        nextAttemptAt: at + backoff(attempts),
      }, at);
    }

    const after = deps.store.listJobs(run.executionKey);
    const unfinished = after.filter((job) => job.status === "pending").length;
    const failed = after.filter((job) => job.status === "failed").length;
    if (unfinished === 0) {
      deps.store.updateRun(run.executionKey, {
        status: "done",
        lastError: failed > 0 ? `${failed} entit${failed === 1 ? "y" : "ies"} failed` : null,
        nextAttemptAt: 0,
        updatedAt: at,
      });
      log(`entity capture: ${run.executionKey} complete${failed > 0 ? ` with ${failed} failed` : ""}`);
    }
  }

  async function processRun(initial: EntityCaptureRun, at = now()): Promise<void> {
    const key = initial.executionKey;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    const promise = (async () => {
      try {
        const run = deps.store.getRun(key);
        if (!run || run.status === "done" || run.status === "failed") return;
        if (run.status === "pending") await extract(run, at);
        const after = deps.store.getRun(key);
        if (after?.status === "processing") await writeJobs(after, at);
      } catch (error) {
        failRun(key, error, at);
      } finally {
        inFlight.delete(key);
      }
    })();
    await track(promise);
  }

  async function flushThread(threadId: string, at = now()): Promise<void> {
    const entry = pending.get(threadId);
    if (!entry) return;
    pending.delete(threadId);
    const executionKey = `${threadId}:${entry.turnId}`;
    if (deps.store.getRun(executionKey)) return;
    const created = deps.store.createRun({
      executionKey,
      threadId,
      turnId: entry.turnId,
      botId: entry.botId,
      agent: entry.agent,
      status: "pending",
      attempts: 0,
      lastError: null,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    });
    if (!created) return;
    await processRun(deps.store.getRun(executionKey)!, at);
  }

  const upkeep: EntityUpkeep = {
    noteTurn(threadId, turnId) {
      if (!deps.enabled() || paused || !turnId) return;
      const bot = deps.botByThread(threadId);
      const agent = bot?.relayAgent === "scout" || bot?.relayAgent === "mercury" ? bot.relayAgent : null;
      if (!bot || !agent || !bot.ownerUserId) return;
      if (deps.eligibleThread && !deps.eligibleThread(threadId, bot.id)) return;
      const messages = deps.threadMessages(threadId);
      if (!deps.isResearchExecutionThread(threadId) && !isResearchThread(messages, turnId)) return;
      pending.set(threadId, { turnId, botId: bot.id, agent, dueAt: now() + deps.quietMs() });
    },

    flushThread: (threadId) => flushThread(threadId),

    async tick(at = now()) {
      if (!deps.enabled() || paused || ticking) return;
      ticking = true;
      try {
        for (const [threadId, entry] of pending) {
          if (entry.dueAt > at) continue;
          await flushThread(threadId, at);
        }
        for (const run of deps.store.dueRuns(at)) {
          if (run.nextAttemptAt > at) continue;
          await processRun(run, at);
        }
      } finally {
        ticking = false;
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void upkeep.tick().catch((error: unknown) => log(`entity capture: tick failed: ${error instanceof Error ? error.message : "unknown"}`)), CAPTURE_TICK_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    pause() {
      paused = true;
    },

    resume() {
      paused = false;
    },

    async idle() {
      while (tracked.size > 0) {
        await Promise.allSettled(tracked);
      }
    },
  };

  return upkeep;
}
