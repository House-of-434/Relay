import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireInteractiveLease, interactiveLeasePath } from "./login-lease.js";

const USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MAX = 1_000;

test("one lease per user across callers; release frees it", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-lease-"));
  try {
    let now = 10_000;
    const first = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX, now: () => now });
    assert.ok(first);
    const second = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX, now: () => now });
    assert.equal(second, null);
    first.release();
    first.release(); // idempotent
    const third = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX, now: () => now });
    assert.ok(third);
    third.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease older than the hard cap is reclaimed", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-lease-"));
  try {
    let now = 10_000;
    const first = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX, now: () => now });
    assert.ok(first);
    now += MAX + 1;
    const second = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX, now: () => now });
    assert.ok(second);
    second.release();
    assert.equal(interactiveLeasePath(root, USER).endsWith(".interactive-session.lock"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease left by a dead process is reclaimed", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-lease-"));
  try {
    const path = interactiveLeasePath(root, USER);
    mkdirSync(join(root, USER), { recursive: true });
    writeFileSync(path, JSON.stringify({ token: "dead", startedAt: Date.now(), pid: 999_999 }), { mode: 0o600 });
    const lease = acquireInteractiveLease({ dataRoot: root, userId: USER, maxLifetimeMs: MAX });
    assert.ok(lease);
    lease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
