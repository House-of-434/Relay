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

test("admission timeout defaults to three minutes", () => {
  assert.equal(workerConfig({}).admissionTimeoutMs, 180_000);
});

test("RELAY_SCRIBE_ADMISSION_TIMEOUT_MS overrides within the 30s-10min bounds", () => {
  assert.equal(workerConfig({ RELAY_SCRIBE_ADMISSION_TIMEOUT_MS: "30000" }).admissionTimeoutMs, 30_000);
  assert.equal(workerConfig({ RELAY_SCRIBE_ADMISSION_TIMEOUT_MS: "600000" }).admissionTimeoutMs, 600_000);
  assert.equal(workerConfig({ RELAY_SCRIBE_ADMISSION_TIMEOUT_MS: "120000.9" }).admissionTimeoutMs, 120_000);
});

test("an invalid admission timeout falls back instead of disabling the wait", () => {
  for (const value of ["0", "-1", "NaN", "Infinity", "1e12", "29999", "600001", "abc", ""]) {
    assert.equal(workerConfig({ RELAY_SCRIBE_ADMISSION_TIMEOUT_MS: value }).admissionTimeoutMs, 180_000, value);
  }
});
