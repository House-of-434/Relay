/** Monitor drain of manual intents: immediately-due arming, receipt dedupe,
// worker-throw retry, terminal notice-once, late-window unreachable, and the
// intent-armed callback. Calendar behavior is pinned by scribe-monitor.test.ts;
// this file only covers the manual producer path. */
import { describe, expect, it } from "vitest";

import {
  joinRequestFromIntent,
  type ScribePlatform,
} from "./scribe-intents.ts";
import type { ScribeJoinIntent } from "./message-db.ts";
import {
  ScribeMonitor,
  type JoinRequest,
  type ReceiptStore,
  type ScribeDescriptor,
  type ScribeMonitorConfig,
  type ScribeNotice,
  type ScribeWorkerStatus,
} from "./scribe-monitor.ts";

const NOW = 1_000_000;
const cfg: ScribeMonitorConfig = {
  pollMs: 60_000, windowBackMs: 86_400_000, windowForwardMs: 86_400_000,
  armLeadMs: 60_000, lateMaxMs: 300_000, manualLateMs: 300_000,
  maxResults: 250, reconcileGraceMs: 1_800_000, adminAlertIntervalMs: 10_800_000,
};

function fakeReceipts(): ReceiptStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    has: (kind, key) => keys.has(`${kind}:${key}`),
    record: (kind, key) => { keys.add(`${kind}:${key}`); },
  };
}

function intent(over: Partial<ScribeJoinIntent> = {}): ScribeJoinIntent {
  return {
    requestKey: "req-1",
    instanceId: "inst-manual-1",
    source: "manual",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    urlKey: "google_meet|meet.google.com/abc-defg-hij",
    platform: "google_meet",
    title: "Investor sync",
    organizerEmail: "owner@houseof434.com",
    ownerUserId: "owner",
    botId: "bot",
    threadId: "thread",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const manualRequest = (over: Partial<ScribeJoinIntent> = {}): JoinRequest =>
  joinRequestFromIntent(intent(over), { manualLateMs: cfg.manualLateMs, reconcileGraceMs: cfg.reconcileGraceMs });

interface Harness {
  joined: ScribeDescriptor[];
  statuses: Map<string, ScribeWorkerStatus>;
  notices: ScribeNotice[];
  armed: string[];
  receipts: ReceiptStore & { keys: Set<string> };
  joinBehavior?: (d: ScribeDescriptor) => Promise<{ status: string }>;
}

function build(h: Partial<Harness> & { manual?: JoinRequest[] } = {}) {
  const full: Harness = {
    joined: [], statuses: new Map(), notices: [], armed: [],
    receipts: fakeReceipts(), ...h,
  };
  const monitor = new ScribeMonitor(
    {
      listEvents: async () => [],
      joinWorker: full.joinBehavior ?? (async (d) => { full.joined.push(d); return { status: "joining" }; }),
      status: async (id) => full.statuses.get(id) ?? { instance_id: id, status: "unknown", segment_count: 0 },
      receipts: full.receipts,
      listManualRequests: async () => h.manual ?? [],
      noteManualArmed: (id) => { full.armed.push(id); },
      notify: (n) => { full.notices.push(n); },
    },
    cfg,
  );
  return { monitor, full };
}

describe("manual intent drain", () => {
  it("arms an immediately-due manual request on tick and marks the intent", async () => {
    const { monitor, full } = build({ manual: [manualRequest()] });
    await monitor.tick(NOW + 5_000);
    expect(full.joined).toHaveLength(1);
    expect(full.joined[0]).toMatchObject({ instance_id: "inst-manual-1", meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(full.armed).toEqual(["inst-manual-1"]);
    expect(full.receipts.keys.has("scribe.arm:manual|inst-manual-1")).toBe(true);
  });

  it("reconciles instead of re-arming once the arm receipt exists", async () => {
    const req = manualRequest();
    const { monitor, full } = build({ manual: [req] });
    await monitor.tick(NOW + 5_000);
    full.statuses.set(req.descriptor.instance_id, { status: "completed", segment_count: 3 });
    full.joined.length = 0;
    await monitor.tick(NOW + 65_000);
    expect(full.joined).toHaveLength(0);
    expect(full.notices).toHaveLength(1);
    expect(full.notices[0]).toMatchObject({ instance_id: "inst-manual-1", kind: "completed" });
  });

  it("retries next tick when the worker throws, recording nothing", async () => {
    let calls = 0;
    const { monitor, full } = build({
      manual: [manualRequest()],
      joinBehavior: async (d) => {
        calls += 1;
        if (calls === 1) throw new Error("connection refused");
        full.joined.push(d);
        return { status: "joining" };
      },
    });
    await monitor.tick(NOW + 5_000);
    expect(full.joined).toHaveLength(0);
    expect(full.armed).toHaveLength(0);
    await monitor.tick(NOW + 65_000);
    expect(full.joined).toHaveLength(1);
    expect(full.armed).toEqual(["inst-manual-1"]);
  });

  it("marks terminally unreachable with one notice past the manual window", async () => {
    const { monitor, full } = build({ manual: [manualRequest()] });
    await monitor.tick(NOW + cfg.manualLateMs + 1_000);
    expect(full.joined).toHaveLength(0);
    expect(full.notices).toHaveLength(1);
    expect(full.notices[0]).toMatchObject({ instance_id: "inst-manual-1", kind: "unreachable" });
  });

  it("does nothing without manual deps (calendar-only operation)", async () => {
    const receipts = fakeReceipts();
    const monitor = new ScribeMonitor(
      {
        listEvents: async () => [],
        joinWorker: async () => ({ status: "joining" }),
        status: async (id) => ({ instance_id: id, status: "unknown", segment_count: 0 }),
        receipts,
      },
      cfg,
    );
    await monitor.tick(NOW);
    expect(receipts.keys.size).toBe(0);
  });

  it("treats a worker refusal as terminal for manual joins too", async () => {
    const { monitor, full } = build({
      manual: [manualRequest()],
      joinBehavior: async () => ({ status: "failed" }),
    });
    await monitor.tick(NOW + 5_000);
    expect(full.joined).toHaveLength(0);
    expect(full.armed).toHaveLength(1);
    full.statuses.set("inst-manual-1", { status: "failed", error: "at capacity" });
    await monitor.tick(NOW + 65_000);
    expect(full.notices).toHaveLength(1);
    expect(full.notices[0].kind).toBe("failed");
  });
});

describe("manual platform coverage", () => {
  it("builds descriptors for zoom and teams intents", () => {
    for (const [platform, url] of [
      ["zoom", "https://houseof434.zoom.us/j/123?pwd=abc"],
      ["teams", "https://teams.microsoft.com/l/meetup-join/19%3Aabc"],
    ] as Array<[ScribePlatform, string]>) {
      const request = joinRequestFromIntent(
        intent({ platform, meetingUrl: url, urlKey: `${platform}|x` }),
        { manualLateMs: cfg.manualLateMs, reconcileGraceMs: cfg.reconcileGraceMs },
      );
      expect(request.descriptor.platform).toBe(platform);
      expect(request.descriptor.meeting_url).toBe(url);
    }
  });
});
