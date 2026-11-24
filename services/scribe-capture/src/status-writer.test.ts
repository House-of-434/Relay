import assert from "node:assert/strict";
import test from "node:test";

import { CaptureStatusWriter, type CaptureStatusPost } from "./status-writer.js";
import type { CaptureStatus } from "./types.js";

function recorder(): { seen: CaptureStatus[]; writer: CaptureStatusWriter } {
  const seen: CaptureStatus[] = [];
  const post: CaptureStatusPost = async (status) => { seen.push(status); };
  return { seen, writer: new CaptureStatusWriter(post) };
}

test("an immediately admitted capture persists joining then active", async () => {
  const { seen, writer } = recorder();
  await writer.publish("joining");
  await writer.publish("active");
  assert.deepEqual(seen, ["joining", "active"]);
});

test("a waiting capture persists joining, awaiting_admission, then active", async () => {
  const { seen, writer } = recorder();
  await writer.publish("joining");
  await writer.publish("awaiting_admission");
  await writer.publish("active");
  assert.deepEqual(seen, ["joining", "awaiting_admission", "active"]);
});

test("a capture that is never admitted ends terminal after the waiting state", async () => {
  const { seen, writer } = recorder();
  await writer.publish("joining");
  await writer.publish("awaiting_admission");
  await writer.close();
  seen.push("failed");
  assert.deepEqual(seen, ["joining", "awaiting_admission", "failed"]);
});

test("a late waiting update cannot follow active", async () => {
  const { seen, writer } = recorder();
  await writer.publish("joining");
  await writer.publish("active");
  await writer.publish("awaiting_admission");
  assert.deepEqual(seen, ["joining", "active"]);
});

test("a rejected post reaches its caller without breaking later writes", async () => {
  const seen: CaptureStatus[] = [];
  const writer = new CaptureStatusWriter(async (status) => {
    if (status === "joining") throw new Error("ingest down");
    seen.push(status);
  });
  await assert.rejects(() => writer.publish("joining"), /ingest down/);
  await writer.publish("active");
  await writer.close();
  assert.deepEqual(seen, ["active"]);
});

test("close waits for an in-flight write and refuses later ones", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: CaptureStatus[] = [];
  const writer = new CaptureStatusWriter(async (status) => {
    if (status === "awaiting_admission") await gate;
    seen.push(status);
  });
  await writer.publish("joining");
  const pending = writer.publish("awaiting_admission");
  let closed = false;
  const closing = writer.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, "close waits for the in-flight write");
  release();
  await pending;
  await closing;
  seen.push("failed");
  await writer.publish("active");
  assert.deepEqual(seen, ["joining", "awaiting_admission", "failed"]);
});
