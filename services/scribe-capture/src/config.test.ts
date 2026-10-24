import assert from "node:assert/strict";
import test from "node:test";

import { workerConfig } from "./config.js";

const DAY = 24 * 60 * 60 * 1000;

test("diagnostic retention defaults to 30 days and probes stay under the scribe data root", () => {
  const config = workerConfig({});
  assert.equal(config.retentionMs, 30 * DAY);
  assert.equal(config.probeDir, "/data/scribe/probes");
});

test("RELAY_SCRIBE_RETENTION_MS overrides the default", () => {
  assert.equal(workerConfig({ RELAY_SCRIBE_RETENTION_MS: String(7 * DAY) }).retentionMs, 7 * DAY);
});
