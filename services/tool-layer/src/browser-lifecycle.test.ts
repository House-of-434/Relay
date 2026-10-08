import assert from "node:assert/strict";
import test from "node:test";

import {
  BLADE_ACTION_TIMEOUT_MS,
  BLADE_ALLOWED_ENV,
  BLADE_IDLE_RECLAIM_MS,
  MAX_BLADE_DAEMONS,
  artifactsDirFor,
  assertIsolatedDaemonConfig,
} from "./infra/browser-lifecycle.js";
import { workspaceRootFor } from "./infra/workspace-identity.js";

const ALICE = "123e4567-e89b-42d3-a456-426614174000";
const BOB = "123e4567-e89b-42d3-a456-426614174001";

test("artifacts live inside the user's own workspace", () => {
  const root = workspaceRootFor("/data/blade", ALICE);
  assert.ok(artifactsDirFor(root).startsWith(`${root}/`));
  assert.notEqual(
    artifactsDirFor(workspaceRootFor("/data/blade", ALICE)),
    artifactsDirFor(workspaceRootFor("/data/blade", BOB)),
  );
});

test("real-browser lane and unknown lanes fail closed", () => {
  assert.doesNotThrow(() => assertIsolatedDaemonConfig({}));
  assert.throws(() => assertIsolatedDaemonConfig({ lane: "real" }), /real-browser lane is forbidden/);
  assert.throws(() => assertIsolatedDaemonConfig({ lane: "attach" }), /outside the isolated workspace/);
});

test("no lane, rb, or foreign-endpoint variable can cross into daemon env", () => {
  const env = BLADE_ALLOWED_ENV as readonly string[];
  for (const banned of ["BLADE_LANE", "BLADE_RB_DEBUG", "BLADE_TRANSPORT"]) {
    assert.ok(!env.includes(banned), `${banned} must never be forwarded`);
  }
  assert.ok(env.includes("BLADE_HOME") && env.includes("BLADE_PROXY"));
});

test("budgets are sane", () => {
  assert.equal(BLADE_IDLE_RECLAIM_MS, 10 * 60_000);
  assert.ok(MAX_BLADE_DAEMONS >= 10);
  assert.ok(BLADE_ACTION_TIMEOUT_MS >= 60_000);
});
