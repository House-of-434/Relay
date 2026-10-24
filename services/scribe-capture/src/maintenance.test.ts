import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { diskFreeBelow, expiredFiles, maintainDiagnostics } from "./maintenance.js";
import { describeJoinFailure } from "./errors.js";

const DAY = 24 * 60 * 60 * 1000;

test("expiredFiles selects only files past the retention window", () => {
  const now = 100 * DAY;
  const entries = [
    { path: "fresh.png", mtimeMs: now - 1 * DAY },
    { path: "edge.png", mtimeMs: now - 14 * DAY },
    { path: "old.png", mtimeMs: now - 15 * DAY },
  ];
  assert.deepEqual(expiredFiles(entries, now, 14 * DAY), ["old.png"]);
});

test("diskFreeBelow compares free space to the threshold", () => {
  assert.equal(diskFreeBelow(500, 1000), true);
  assert.equal(diskFreeBelow(1500, 1000), false);
});

test("describeJoinFailure names the signed-out case specifically", () => {
  const auth = new Error("Browser profile signed out — cannot authenticate with Google");
  auth.name = "AuthSessionError";
  assert.match(describeJoinFailure(auth), /signed out/);
  assert.match(describeJoinFailure(new Error("profile is signed out")), /signed out/);
  assert.equal(describeJoinFailure(new Error("could not locate join button")), "could not locate join button");
});


test("diagnostic maintenance removes expired probes, failures, and status files but never the profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-scribe-maintenance-"));
  const now = 100 * DAY;
  const dirs = {
    probes: join(root, "probes"),
    failures: join(root, "failures"),
    status: join(root, "status"),
    profile: join(root, "profile"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  for (const [name, dir] of Object.entries(dirs)) {
    const old = join(dir, "old.txt");
    const fresh = join(dir, "fresh.txt");
    writeFileSync(old, name);
    writeFileSync(fresh, name);
    utimesSync(old, new Date(now - 31 * DAY), new Date(now - 31 * DAY));
  }
  const removed = await maintainDiagnostics([dirs.probes, dirs.failures, dirs.status], 30 * DAY, now);
  assert.equal(removed, 3);
  for (const dir of [dirs.probes, dirs.failures, dirs.status]) {
    assert.equal(existsSync(join(dir, "old.txt")), false);
    assert.equal(existsSync(join(dir, "fresh.txt")), true);
  }
  assert.equal(existsSync(join(dirs.profile, "old.txt")), true);
  rmSync(root, { recursive: true, force: true });
});
