import assert from "node:assert/strict";
import test from "node:test";

import { diskFreeBelow, expiredFiles } from "./maintenance.js";
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
