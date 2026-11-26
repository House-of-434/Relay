import { describe, expect, it } from "vitest";

import type { CaptureMessage } from "./entity-capture.ts";
import { CAPTURE_BACKOFF_BASE_MS, createEntityUpkeep, type EntityUpkeepDeps, type EntityUpkeepStore } from "./entity-upkeep.ts";
import type { EntityCaptureJob, EntityCaptureRun } from "./message-db.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const QUIET = 60_000;
const START = 1_000_000;

function memoryStore(): EntityUpkeepStore {
  const runs = new Map<string, EntityCaptureRun>();
  const jobs = new Map<string, EntityCaptureJob[]>();
  return {
    createRun(run) {
      if (runs.has(run.executionKey)) return false;
      runs.set(run.executionKey, { ...run });
      return true;
    },
    getRun(key) {
      const run = runs.get(key);
      return run ? { ...run } : null;
    },
    updateRun(key, patch) {
      const run = runs.get(key);
      if (run) runs.set(key, { ...run, ...patch });
    },
    dueRuns(now, limit = 10) {
      return [...runs.values()]
        .filter((run) => (run.status === "pending" || run.status === "processing") && run.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((run) => ({ ...run }));
    },
    createJobs(key, incoming) {
      const list = jobs.get(key) ?? [];
      for (const job of incoming) {
        if (!list.some((existing) => existing.entityKey === job.entityKey)) list.push({ ...job });
      }
      jobs.set(key, list);
    },
    listJobs(key) {
      return (jobs.get(key) ?? []).map((job) => ({ ...job }));
    },
    updateJob(key, entityKey, patch) {
      const list = jobs.get(key) ?? [];
      const index = list.findIndex((job) => job.entityKey === entityKey);
      if (index >= 0) list[index] = { ...list[index]!, ...patch };
    },
  };
}

interface Harness {
  upkeep: ReturnType<typeof createEntityUpkeep>;
  store: EntityUpkeepStore;
  calls: Array<{ table: string; data: Record<string, unknown> }>;
  messages: CaptureMessage[];
  setNow: (value: number) => void;
  setDecision: (value: { dedicated?: boolean } | null) => void;
  setEngine: (value: string | null) => void;
  setRunTool: (value: EntityUpkeepDeps["runTool"]) => void;
}

function harness(options: { dedicated?: boolean; report?: string; activity?: boolean } = {}): Harness {
  let clock = START;
  let dedicated = options.dedicated ?? false;
  let engineAnswer: string | null = JSON.stringify({
    companies: [{ name: "Acme", domains: ["acme.example"], source_url: "https://acme.example", confidence: 0.9 }],
    people: [{ full_name: "Ada Test", company: "Acme", source_url: "https://acme.example/ada", confidence: 0.9 }],
  });
  const calls: Array<{ table: string; data: Record<string, unknown> }> = [];
  const messages: CaptureMessage[] = [
    { role: "user", kind: "text", text: "Research Acme", turnId: "t1" },
    { role: "bot", kind: "text", text: options.report ?? "Acme is a company. Its founder is Ada Test.", turnId: "t1" },
    ...(options.activity === false ? [] : [{ role: "bot" as const, kind: "activity", turnId: "t1", tool: { name: "web_search", summary: "acme" } }]),
  ];
  let runTool: EntityUpkeepDeps["runTool"] = async ({ args }) => {
    const table = String(args.table);
    calls.push({ table, data: args.data as Record<string, unknown> });
    return { ok: true, text: JSON.stringify({ status: "created", id: table === "app.companies" ? "company-1" : "person-1" }) };
  };
  const store = memoryStore();
  const upkeep = createEntityUpkeep({
    store,
    enabled: () => true,
    bot: () => ({ id: BOT, name: "Scout", ownerUserId: USER, relayAgent: "scout" }),
    botByThread: () => ({ id: BOT, name: "Scout", ownerUserId: USER, relayAgent: "scout" }),
    engine: () => engineAnswer === null ? null : { generateText: async () => engineAnswer! },
    threadMessages: () => messages,
    isResearchExecutionThread: () => dedicated,
    quietMs: () => QUIET,
    signActor: () => "assertion",
    runTool: (input) => runTool(input),
    now: () => clock,
    today: () => "2026-11-25",
  });
  return {
    upkeep,
    store,
    calls,
    messages,
    setNow: (value) => { clock = value; },
    setDecision: (value) => { dedicated = value?.dedicated ?? false; },
    setEngine: (value) => { engineAnswer = value; },
    setRunTool: (value) => { runTool = value; },
  };
}

describe("research entity upkeep", () => {
  it("extracts one company and one person after the quiet window and writes the company first", async () => {
    const h = harness();
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);

    const run = h.store.getRun(`${THREAD}:t1`);
    expect(run?.status).toBe("done");
    expect(h.calls.map((call) => call.table)).toEqual(["app.companies", "app.people"]);
    expect(h.calls[0]!.data).toMatchObject({
      name: "Acme",
      domains: ["acme.example"],
      source: "research",
      source_url: "https://acme.example",
      observed_at: new Date(START + QUIET + 1).toISOString(),
      confidence: 0.9,
    });
    expect(h.calls[1]!.data).toMatchObject({
      full_name: "Ada Test",
      company: "Acme",
      company_id: "company-1",
      source: "research",
      source_url: "https://acme.example/ada",
    });
    expect(h.store.listJobs(`${THREAD}:t1`).every((job) => job.status === "done")).toBe(true);
  });

  it("does nothing for a turn with no research activity", async () => {
    const h = harness({ activity: false });
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    expect(h.calls).toEqual([]);
    expect(h.store.dueRuns(START + QUIET + 1)).toEqual([]);
  });

  it("captures a dedicated research thread even without an activity row", async () => {
    const h = harness({ dedicated: true, activity: false });
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("done");
    expect(h.calls.length).toBe(2);
  });

  it("a later research turn in the same thread is a new execution", async () => {
    const h = harness();
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    h.messages.push({ role: "bot", kind: "activity", turnId: "t2", tool: { name: "web_fetch" } });
    h.upkeep.noteTurn(THREAD, "t2");
    await h.upkeep.tick(START + QUIET + 2);
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("done");
    expect(h.store.getRun(`${THREAD}:t2`)?.status).toBe("done");
    expect(h.calls.length).toBe(4);
  });

  it("updates the turn key when a new turn arrives before the quiet flush", async () => {
    const h = harness();
    h.upkeep.noteTurn(THREAD, "t1");
    h.messages.push({ role: "bot", kind: "activity", turnId: "t2", tool: { name: "web_fetch" } });
    h.upkeep.noteTurn(THREAD, "t2");
    await h.upkeep.tick(START + QUIET + 1);
    expect(h.store.getRun(`${THREAD}:t1`)).toBeNull();
    expect(h.store.getRun(`${THREAD}:t2`)?.status).toBe("done");
  });

  it("retries a failed company write and holds its people until it succeeds", async () => {
    const h = harness();
    let companyAttempts = 0;
    h.setRunTool(async ({ args }) => {
      const table = String(args.table);
      h.calls.push({ table, data: args.data as Record<string, unknown> });
      if (table === "app.companies" && companyAttempts++ === 0) {
        return { ok: false, text: "database unavailable" };
      }
      return { ok: true, text: JSON.stringify({ status: "created", id: table === "app.companies" ? "company-1" : "person-1" }) };
    });
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    expect(h.calls.map((call) => call.table)).toEqual(["app.companies"]);
    const companyKey = h.store.listJobs(`${THREAD}:t1`).find((job) => job.kind === "company")!.entityKey;
    expect(h.store.listJobs(`${THREAD}:t1`).find((job) => job.entityKey === companyKey)?.attempts).toBe(1);

    h.setNow(START + QUIET + 1 + CAPTURE_BACKOFF_BASE_MS + 1);
    await h.upkeep.tick(START + QUIET + 1 + CAPTURE_BACKOFF_BASE_MS + 1);
    expect(h.calls.map((call) => call.table)).toEqual(["app.companies", "app.companies", "app.people"]);
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("done");
  });

  it("does not retry a terminal validation failure five times", async () => {
    const h = harness();
    h.setRunTool(async ({ args }) => {
      const table = String(args.table);
      h.calls.push({ table, data: args.data as Record<string, unknown> });
      if (table === "app.companies") return { ok: false, text: "source_url must be an http(s) URL" };
      return { ok: true, text: JSON.stringify({ status: "created", id: "person-1" }) };
    });
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    const jobs = h.store.listJobs(`${THREAD}:t1`);
    const company = jobs.find((job) => job.kind === "company")!;
    expect(company.status).toBe("failed");
    expect(company.attempts).toBe(1);
    expect(jobs.find((job) => job.kind === "person")?.status).toBe("done");
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("done");
  });

  it("retries a failed extraction up to three attempts", async () => {
    const h = harness();
    h.setEngine("not json");
    h.upkeep.noteTurn(THREAD, "t1");
    await h.upkeep.tick(START + QUIET + 1);
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("pending");
    expect(h.store.getRun(`${THREAD}:t1`)?.attempts).toBe(1);

    let at = START + QUIET + 1 + CAPTURE_BACKOFF_BASE_MS * 2 + 2;
    await h.upkeep.tick(at);
    expect(h.store.getRun(`${THREAD}:t1`)?.attempts).toBe(2);
    at += CAPTURE_BACKOFF_BASE_MS * 4;
    await h.upkeep.tick(at);
    expect(h.store.getRun(`${THREAD}:t1`)?.status).toBe("failed");
    expect(h.store.getRun(`${THREAD}:t1`)?.attempts).toBe(3);
  });
});
