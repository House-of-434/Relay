import assert from "node:assert/strict";
import test from "node:test";

import { authorize } from "./domain/permissions.js";
import { prepareWrite, validateFilters } from "./domain/shapes.js";

const UUID = "2c90d6a2-5ade-4e7a-bb55-205a8b9e3918";
const ACTOR_USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";

test("table access is bound to the agent and project", () => {
  assert.equal(authorize("scout", "read", "app.companies"), "relay");
  assert.equal(authorize("mercury", "read", "public.suppressed_emails"), "newsletter");
  assert.throws(() => authorize("scout", "read", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("scout", "write", "history.generated_docs"), /denied/);
  assert.throws(() => authorize("mercury", "read", "logs.turns"), /denied/);
  assert.throws(() => authorize("curator", "write", "app.companies"), /denied/);
  assert.throws(() => authorize("curator", "write", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("mercury", "write", "public.invitation_requests"), /denied/);
});

test("conversation history is readable by every agent and writable by none", () => {
  for (const agent of ["scout", "mercury", "curator"] as const) {
    assert.equal(authorize(agent, "read", "history.conversations"), "relay");
    assert.throws(() => authorize(agent, "write", "history.conversations"), /write access denied/);
  }
  // Removed tables stay denied because no permission entry names them.
  for (const table of ["app.captures", "transcripts.email_threads", "history.generated_docs", "logs.turns"]) {
    assert.throws(() => authorize("mercury", "read", table), /denied/);
    assert.throws(() => authorize("mercury", "write", table), /denied/);
  }
});

test("entity inserts force actor identity and classification", () => {
  const prepared = prepareWrite(
    "app.companies",
    "insert",
    {
      name: "Acme",
      source_url: "https://example.com/acme",
      confidence: 0.8,
      actor_user: "attacker@example.com",
      actor_agent: "curator",
      classification: "internal",
      embedding: [1, 2, 3],
    },
    undefined,
    { agent: "scout", userId: ACTOR_USER_ID },
    "2026-09-29T12:00:00.000Z",
  );

  assert.deepEqual(prepared.values, {
    name: "Acme",
    source_url: "https://example.com/acme",
    confidence: 0.8,
    actor_user: ACTOR_USER_ID,
    actor_agent: "scout",
    classification: "internal",
    embedding: null,
    created_at: "2026-09-29T12:00:00.000Z",
    updated_at: "2026-09-29T12:00:00.000Z",
    captured_at: "2026-09-29T12:00:00.000Z",
  });
});

test("unknown columns and unsafe broad updates are rejected", () => {
  assert.throws(() => prepareWrite(
    "app.companies", "insert", { name: "Acme", actor_user_id: "forged" }, undefined,
    { agent: "scout", userId: null },
  ), /Unknown column/);

  assert.throws(() => prepareWrite(
    "app.companies", "update", { description: "Changed" }, { name: "Acme" },
    { agent: "scout", userId: ACTOR_USER_ID },
  ), /where must contain only id/);

  // The entity status column was removed: there is no promotion step to write.
  assert.throws(() => prepareWrite(
    "app.companies", "update", { description: "Changed", status: "active" }, { id: UUID },
    { agent: "scout", userId: ACTOR_USER_ID },
  ), /Unknown column/);

  const update = prepareWrite(
    "app.companies", "update", { description: "Changed" }, { id: UUID },
    { agent: "scout", userId: ACTOR_USER_ID },
  );
  assert.deepEqual(update.where, { column: "id", value: UUID });
  assert.throws(() => prepareWrite(
    "app.companies", "insert",
    { name: "Acme", source_url: "https://example.com/acme", confidence: 0.5, classification: "restricted" },
    undefined, { agent: "scout", userId: null },
  ), /classification exceeds/);
});

test("conversation ownership columns are not writable by a model", () => {
  // Conversations expose no writable columns, so any agent-supplied column is
  // refused before a row could be created.
  assert.throws(() => prepareWrite(
    "history.conversations", "insert", { title: "Forged" }, undefined,
    { agent: "mercury", userId: ACTOR_USER_ID },
  ), /Unknown column/);

  // user_id is a server-set column, so it is recognised but never taken from a
  // model; with no writable columns there is nothing left to update.
  assert.throws(() => prepareWrite(
    "history.conversations", "update", { user_id: "forged-owner" }, { id: UUID },
    { agent: "mercury", userId: ACTOR_USER_ID },
  ), /data must contain at least one writable column/);
});

test("owned writes store stable UUID identity in actor_user", () => {
  const prepared = prepareWrite(
    "app.companies", "insert",
    { name: "Acme", source_url: "https://example.com/acme", confidence: 0.5 }, undefined,
    { agent: "curator", userId: ACTOR_USER_ID }, "2026-09-29T12:00:00.000Z",
  );
  assert.equal(prepared.values.actor_user, ACTOR_USER_ID);
  assert.equal("created_by" in prepared.values, false);

  assert.throws(() => prepareWrite(
    "app.companies", "insert",
    { name: "Acme", source_url: "https://example.com/acme", confidence: 0.5 }, undefined,
    { agent: "scout", userId: "analyst@houseof434.com" },
  ), /UUID/);
});

test("filters allow only shaped columns and fixed operators", () => {
  assert.deepEqual(
    validateFilters("app.companies", { name_like: "%acme%", observed_at_gte: "2026-01-01" }),
    [
      { column: "name", operator: "like", value: "%acme%" },
      { column: "observed_at", operator: "gte", value: "2026-01-01" },
    ],
  );
  assert.throws(() => validateFilters("app.companies", { or: "name.eq.Acme" }), /not filterable/);
  assert.throws(() => validateFilters("app.companies", { name_in: [] }), /1–100/);
  assert.deepEqual(validateFilters("app.companies", { actor_user: ACTOR_USER_ID }), [
    { column: "actor_user", operator: "eq", value: ACTOR_USER_ID },
  ]);
  assert.throws(() => validateFilters("app.companies", { actor_user: "analyst@houseof434.com" }), /UUID/);
  assert.throws(() => validateFilters("public.newsletter_subscribers", { email: "a@example.com" }), /No column shape/);
});
