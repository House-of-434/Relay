import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { createScribeWorkerServer } from "./http-server.js";
import { workerConfig, type WorkerConfig } from "./config.js";
import type { JoinController, JoinDescriptor, JoinOutcome, StatusOutcome } from "./types.js";

const CAP = "worker-capability-that-is-at-least-32-bytes-long";

class FakeController implements JoinController {
  readonly joins: JoinDescriptor[] = [];
  private readonly live = new Map<string, { status: string; segments: number }>();

  async join(descriptor: JoinDescriptor): Promise<JoinOutcome> {
    const existing = this.live.get(descriptor.instance_id);
    if (existing) return { instance_id: descriptor.instance_id, status: existing.status as any };
    this.joins.push(descriptor);
    this.live.set(descriptor.instance_id, { status: "joining", segments: 0 });
    return { instance_id: descriptor.instance_id, status: "joining" };
  }
  async status(instanceId: string): Promise<StatusOutcome> {
    const s = this.live.get(instanceId);
    const boot = "11111111-1111-4111-8111-111111111111";
    return s
      ? { instance_id: instanceId, status: s.status as never, segment_count: s.segments, worker_boot_id: boot }
      : { instance_id: instanceId, status: "unknown", segment_count: 0, worker_boot_id: boot };
  }
  async stop(instanceId: string): Promise<JoinOutcome> {
    this.live.set(instanceId, { status: "partial", segments: 0 });
    return { instance_id: instanceId, status: "partial" };
  }
}

async function withServer(run: (base: string, controller: FakeController) => Promise<void>, overrides: Partial<WorkerConfig> = {}) {
  const controller = new FakeController();
  const config = { ...workerConfig({} as NodeJS.ProcessEnv), workerCapability: CAP, enabled: true, ...overrides };
  const server = createScribeWorkerServer(controller, config);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, controller);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown, cap = CAP) =>
  fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("rejects a wrong capability before doing anything", async () => {
  await withServer(async (base, controller) => {
    const res = await post(base, "/join", { instance_id: "i1", platform: "google_meet", meeting_url: "https://meet.google.com/abc" }, "wrong-capability-value-that-is-long-enough-000");
    assert.equal(res.status, 401);
    assert.equal(controller.joins.length, 0);
  });
});

test("join is idempotent by instance_id", async () => {
  await withServer(async (base, controller) => {
    const descriptor = { instance_id: "i1", platform: "google_meet", meeting_url: "https://meet.google.com/abc" };
    const first = await post(base, "/join", descriptor);
    const second = await post(base, "/join", descriptor);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(controller.joins.length, 1);
  });
});

test("status and stop route by instance_id", async () => {
  await withServer(async (base) => {
    await post(base, "/join", { instance_id: "i9", platform: "google_meet", meeting_url: "https://meet.google.com/abc" });
    const s = await (await post(base, "/status", { instance_id: "i9" })).json() as StatusOutcome;
    assert.equal(s.status, "joining");
    const stopped = await (await post(base, "/stop", { instance_id: "i9" })).json() as JoinOutcome;
    assert.equal(stopped.status, "partial");
  });
});

test("rejects a non-JSON body and a bad descriptor", async () => {
  await withServer(async (base) => {
    const wrongType = await fetch(`${base}/join`, { method: "POST", headers: { authorization: `Bearer ${CAP}` }, body: "x" });
    assert.equal(wrongType.status, 415);
    const badDescriptor = await post(base, "/join", { instance_id: "i1" });
    assert.equal(badDescriptor.status, 400);
  });
});

test("healthz needs no capability", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json() as { worker_boot_id?: unknown };
    assert.match(String(body.worker_boot_id ?? ""), /^[0-9a-f-]{36}$/);
  });
});

test("unknown status still carries the worker boot id", async () => {
  await withServer(async (base) => {
    const first = await (await post(base, "/status", { instance_id: "missing" })).json() as StatusOutcome;
    const second = await (await post(base, "/status", { instance_id: "missing" })).json() as StatusOutcome;
    assert.equal(first.status, "unknown");
    assert.match(String(first.worker_boot_id ?? ""), /^[0-9a-f-]{36}$/);
    assert.equal(second.worker_boot_id, first.worker_boot_id);
  });
});
