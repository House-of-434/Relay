import assert from "node:assert/strict";
import test from "node:test";

import { authorize, normalizeTable } from "./domain/permissions.js";
import { prepareWrite, validateFilters, validateSelect } from "./domain/shapes.js";

const UUID = "2c90d6a2-5ade-4e7a-bb55-205a8b9e3918";
const ACTOR_USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";

test("reads are default-allow for every agent on one project; writes stay per-agent", () => {
  for (const agent of ["scout", "mercury", "curator"] as const) {
    assert.equal(authorize(agent, "read", "app.companies"), "relay");
    assert.equal(authorize(agent, "read", "public.invitation_requests"), "relay");
    assert.equal(authorize(agent, "read", "public.newsletter_subscribers"), "relay");
    assert.equal(authorize(agent, "read", "public.host_applications"), "relay");
    assert.equal(authorize(agent, "read", "public.partner_inquiries"), "relay");
    assert.equal(authorize(agent, "read", "public.applications"), "relay");
  }
  assert.throws(() => authorize("scout", "read", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("scout", "write", "history.generated_docs"), /denied/);
  assert.throws(() => authorize("mercury", "read", "logs.turns"), /denied/);
  assert.throws(() => authorize("curator", "write", "app.companies"), /denied/);
  assert.throws(() => authorize("curator", "write", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("mercury", "write", "public.invitation_requests"), /denied/);
  // Routed-but-unshaped tables still fail downstream: permissions routes to
  // relay, the shape registry refuses them.
  assert.equal(authorize("mercury", "read", "public.suppressed_emails"), "relay");
  assert.throws(() => validateFilters("public.suppressed_emails", { email: "a@example.com" }), /No column shape/);
  assert.equal(authorize("scout", "read", "public.unlisted_thing"), "relay");
  assert.throws(() => validateFilters("public.unlisted_thing", { created_at_gte: "2026-01-01" }), /No column shape/);
});

test("the denylist beats default-allow", () => {
  for (const table of ["logs.tool_calls", "auth.users", "storage.objects", "vault.secrets", "public.email_unsubscribe_tokens"]) {
    for (const agent of ["scout", "mercury", "curator"] as const) {
      assert.throws(() => authorize(agent, "read", table), /denied/, `${agent} read ${table}`);
    }
  }
});

test("table names are normalized before matching", () => {
  assert.equal(normalizeTable("app.companies"), "app.companies");
  assert.equal(normalizeTable("  APP.Companies  "), "app.companies");
  assert.equal(normalizeTable('"public"."invitation_requests"'), "public.invitation_requests");
  assert.throws(() => normalizeTable("companies"), /schema-qualified/);
  assert.throws(() => normalizeTable("app.companies.extra"), /schema-qualified/);
  assert.throws(() => normalizeTable("app.or=(1,1)"), /schema-qualified/);
  assert.throws(() => normalizeTable(""), /schema-qualified/);
  assert.equal(authorize("scout", "read", "  PUBLIC.INVITATION_REQUESTS "), "relay");
});

test("select entries must exactly match allowlisted columns", () => {
  assert.deepEqual(validateSelect("public.invitation_requests", ["name", "created_at"]), ["name", "created_at"]);
  // Resource embedding across foreign keys.
  assert.throws(() => validateSelect("public.invitation_requests", ["email,other_table(*)"]), /not selectable|Invalid/);
  assert.throws(() => validateSelect("public.invitation_requests", ["company:other(id)"]), /Invalid/);
  // Casts and json operators.
  assert.throws(() => validateSelect("public.applications", ["role::text"]), /Invalid/);
  assert.throws(() => validateSelect("public.applications", ["role_details->x"]), /Invalid/);
  // Wildcard and whitespace-joined strings.
  assert.throws(() => validateSelect("public.invitation_requests", ["*"]), /Invalid|not selectable/);
  assert.throws(() => validateSelect("public.invitation_requests", ["name email"]), /Invalid|not selectable/);
  assert.throws(() => validateSelect("public.invitation_requests", [""]), /Invalid/);
  // Unknown columns and wrong tables.
  assert.throws(() => validateSelect("public.invitation_requests", ["budget"]), /not selectable/);
  assert.throws(() => validateSelect("public.invitation_requests", ["embedding"]), /not selectable/);
  assert.throws(() => validateSelect("public.invitation_requests", []), /1–50/);
  assert.throws(() => validateSelect("public.unlisted_thing", ["id"]), /No column shape/);
});

test("email filters support exact match only", () => {
  assert.deepEqual(validateFilters("public.invitation_requests", { email: "a@example.com" }), [
    { column: "email", operator: "eq", value: "a@example.com" },
  ]);
  assert.throws(() => validateFilters("public.invitation_requests", { email_like: "%@example.com" }), /only exact match/);
  assert.throws(() => validateFilters("public.newsletter_subscribers", { email_gte: "a" }), /only exact match/);
  assert.throws(() => validateFilters("public.host_applications", { email_in: ["a@example.com"] }), /only exact match/);
});

test("conversation history is readable by every agent and writable by none", () => {
  for (const agent of ["scout", "mercury", "curator"] as const) {
    assert.equal(authorize(agent, "read", "history.conversations"), "relay");
    assert.throws(() => authorize(agent, "write", "history.conversations"), /write access denied/);
  }
  // Removed tables stay unreadable: authorization routes known schemas, but
  // no shape names them, so validation refuses.
  for (const table of ["app.captures", "history.generated_docs"]) {
    assert.equal(authorize("mercury", "read", table), "relay");
    assert.throws(() => validateFilters(table, { created_at_gte: "2026-01-01" }), /No column shape/);
    assert.throws(() => authorize("mercury", "write", table), /denied/);
  }
  for (const table of ["transcripts.email_threads", "logs.turns"]) {
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
  assert.deepEqual(validateFilters("public.newsletter_subscribers", { email: "a@example.com" }), [
    { column: "email", operator: "eq", value: "a@example.com" },
  ]);
  assert.throws(() => validateFilters("public.still_unshaped", { email: "a@example.com" }), /No column shape/);
});
