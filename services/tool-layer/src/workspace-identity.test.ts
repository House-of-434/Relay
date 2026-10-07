import assert from "node:assert/strict";
import test from "node:test";

import { canonicalDataRoot, canonicalUserId, workspaceRootFor } from "./infra/workspace-identity.js";

const ALICE = "123e4567-e89b-42d3-a456-426614174000";
const BOB = "123e4567-e89b-42d3-a456-426614174001";

test("canonical user id lowercases a valid UUID", () => {
  assert.equal(canonicalUserId(ALICE.toUpperCase()), ALICE);
});

test("canonical user id rejects everything that is not a UUID", () => {
  const bad: unknown[] = [
    null,
    undefined,
    42,
    "",
    "alice",
    "not-a-uuid",
    "../etc",
    "/etc/passwd",
    "http://example.com",
    `${ALICE}/../bob`,
    "123e4567-e89b-92d3-a456-426614174000",
    "123e4567-e89b-42d3-c456-426614174000",
  ];
  for (const value of bad) {
    assert.throws(() => canonicalUserId(value), /actor user id/);
  }
});

test("workspace roots are stable per user and disjoint across users", () => {
  const root = "/data/blade";
  assert.equal(workspaceRootFor(root, ALICE), `/data/blade/${ALICE}`);
  assert.equal(workspaceRootFor(root, ALICE), workspaceRootFor(root, ALICE.toUpperCase()));
  assert.notEqual(workspaceRootFor(root, ALICE), workspaceRootFor(root, BOB));
});

test("workspace root rejects unauthenticated and hostile identities", () => {
  assert.throws(() => workspaceRootFor("/data/blade", null), /authenticated/);
  assert.throws(() => workspaceRootFor("/data/blade", ".."), /UUID/);
  assert.throws(() => workspaceRootFor("/data/blade", `${ALICE}/../../etc`), /UUID/);
});

test("data root must be configured and absolute", () => {
  assert.throws(() => canonicalDataRoot(""), /configured/);
  assert.throws(() => canonicalDataRoot(null), /configured/);
  assert.equal(canonicalDataRoot("/data/blade"), "/data/blade");
});
