import assert from "node:assert/strict";
import test from "node:test";

import { authorize, authorizeDirectory } from "./domain/permissions.js";
import { getShape, prepareWrite, validateFilters } from "./domain/shapes.js";

const UUID = "2c90d6a2-5ade-4e7a-bb55-205a8b9e3918";
const ACTOR_USER_ID = "1457cb2a-7543-4b48-8854-a63cd160241f";

test("table access is bound to the agent and project", () => {
  assert.equal(authorize("scout", "read", "app.companies"), "relay");
  assert.equal(authorize("mercury", "read", "public.suppressed_emails"), "relay");
  assert.equal(authorize("scout", "read", "public.applications"), "relay");
  assert.equal(authorize("mercury", "read", "public.applications"), "relay");
  assert.equal(authorize("scout", "read", "public.host_applications"), "relay");
  assert.equal(authorize("scout", "read", "public.partner_inquiries"), "relay");
  assert.equal(authorize("scout", "read", "public.invitation_requests"), "relay");
  assert.throws(() => authorize("curator", "read", "public.applications"), /denied/);
  assert.throws(() => authorize("scout", "write", "public.applications"), /denied/);
  assert.throws(() => authorize("mercury", "write", "public.applications"), /denied/);
  assert.throws(() => authorize("scout", "read", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("scout", "write", "history.generated_docs"), /denied/);
  assert.throws(() => authorize("mercury", "read", "logs.turns"), /denied/);
  assert.throws(() => authorize("curator", "write", "app.companies"), /denied/);
  assert.throws(() => authorize("curator", "write", "transcripts.email_threads"), /denied/);
  assert.throws(() => authorize("mercury", "write", "public.invitation_requests"), /denied/);
});

test("public intake tables read newest first", () => {
  for (const table of [
    "public.applications",
    "public.invitation_requests",
    "public.host_applications",
    "public.partner_inquiries",
    "public.newsletter_subscribers",
    "public.suppressed_emails",
    "public.email_send_log",
  ]) {
    assert.deepEqual(getShape(table).order, { column: "created_at", ascending: false }, table);
  }
});

test("every agent may search the teammate directory", () => {
  for (const agent of ["scout", "mercury", "curator"] as const) {
    assert.doesNotThrow(() => authorizeDirectory(agent, "search"));
  }
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
    owner_user_id: ACTOR_USER_ID,
    scope: "private",
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

  // status is a mirrored Notion pipeline field (migration 0009), not an
  // internal promotion gate, so it is writable like any other column.
  const statusUpdate = prepareWrite(
    "app.companies", "update", { status: "Screening" }, { id: UUID },
    { agent: "scout", userId: ACTOR_USER_ID },
  );
  assert.equal(statusUpdate.values.status, "Screening");
  assert.deepEqual(statusUpdate.where, { column: "id", value: UUID });

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

test("confidence is optional but bounded whenever supplied", () => {
  // A mirrored board row is data, not an agent observation, so an insert need
  // not carry a score; the column default applies.
  const inserted = prepareWrite(
    "app.companies", "insert",
    { name: "Social Gear", source_url: "https://app.notion.com/p/social-gear" }, undefined,
    { agent: "mercury", userId: ACTOR_USER_ID },
  );
  assert.equal("confidence" in inserted.values, false);

  // But any supplied score is bounded, on insert and on update.
  assert.throws(() => prepareWrite(
    "app.companies", "insert",
    { name: "Social Gear", source_url: "https://app.notion.com/p/social-gear", confidence: 2 }, undefined,
    { agent: "mercury", userId: ACTOR_USER_ID },
  ), /confidence must be a finite number between 0 and 1/);
  assert.throws(() => prepareWrite(
    "app.companies", "update", { confidence: -1 }, { id: UUID },
    { agent: "mercury", userId: ACTOR_USER_ID },
  ), /confidence must be a finite number between 0 and 1/);

  const scored = prepareWrite(
    "app.companies", "update", { confidence: 0.9 }, { id: UUID },
    { agent: "mercury", userId: ACTOR_USER_ID },
  );
  assert.equal(scored.values.confidence, 0.9);
});

test("notion sync: the first run inserts a deal, a rerun updates it by id", () => {
  const page = {
    notion_page_id: "3fb2faf9-7eb0-8144-b271-c2149101d198",
    notion_url: "https://app.notion.com/p/Social-Gear-3fb2faf97eb08144b271c2149101d198",
    name: "Social Gear",
    source_url: "https://app.notion.com/p/Social-Gear-3fb2faf97eb08144b271c2149101d198",
    status: "Screening",
    technology: "Vertical AI",
    website: "https://mysocialgear.com",
    founder_name: "Adris Chakraborty",
    founder_email: "adris@lykstage.com",
  };
  // No existing row for this page -> insert, carrying the Notion identity.
  const insert = prepareWrite(
    "app.companies", "insert", { ...page }, undefined,
    { agent: "mercury", userId: ACTOR_USER_ID },
  );
  assert.equal(insert.where, undefined);
  assert.equal(insert.values.notion_page_id, page.notion_page_id);
  assert.equal(insert.values.status, "Screening");
  assert.equal(insert.values.technology, "Vertical AI");
  assert.equal(insert.values.founder_email, "adris@lykstage.com");

  // The page is already mirrored -> update the existing row by its Relay id.
  const existingId = "97e3e8df-6f05-4530-8a3e-e8b3b7e20175";
  const update = prepareWrite(
    "app.companies", "update", { status: "Due Diligence", stage: "Seed" }, { id: existingId },
    { agent: "mercury", userId: ACTOR_USER_ID },
  );
  assert.deepEqual(update.where, { column: "id", value: existingId });
  assert.equal(update.values.status, "Due Diligence");
  assert.equal(update.values.stage, "Seed");
});

test("event tracker fields insert without CRM-only requirements", () => {
  const prepared = prepareWrite(
    "app.events",
    "insert",
    {
      title: "AI Beyond the Screen",
      occurred_at: "2026-07-13T00:00:00Z",
      source_url: "https://luma.com/51tyh6y2",
      hosted: "hosted",
      city: "New York",
      speakers: "Nikhil Tyagi — Technology leader",
      media_url: "https://drive.google.com/drive/folders/abc",
      cover_image_url: "https://example.com/poster.png",
      notes: "Recorded.",
    },
    undefined,
    { agent: "scout", userId: ACTOR_USER_ID },
  );
  assert.equal(prepared.values.hosted, "hosted");
  assert.equal(prepared.values.city, "New York");
  assert.equal(prepared.values.speakers, "Nikhil Tyagi — Technology leader");
  assert.equal("attendee_ids" in prepared.values, false);
  assert.equal("type" in prepared.values, false);

  // A supplied type still has to be one of the established event kinds.
  assert.throws(() => prepareWrite(
    "app.events", "insert",
    {
      type: "party",
      title: "AI Beyond the Screen",
      occurred_at: "2026-07-13T00:00:00Z",
      source_url: "https://luma.com/51tyh6y2",
    },
    undefined,
    { agent: "scout", userId: ACTOR_USER_ID },
  ), /outside its allowed set/);

  // Provenance stays mandatory; optional tracker links must still be URLs.
  assert.throws(() => prepareWrite(
    "app.events", "insert",
    { title: "No source", occurred_at: "2026-07-13T00:00:00Z" },
    undefined,
    { agent: "scout", userId: ACTOR_USER_ID },
  ), /source_url/);
  assert.throws(() => prepareWrite(
    "app.events", "insert",
    {
      title: "Bad media",
      occurred_at: "2026-07-13T00:00:00Z",
      source_url: "https://luma.com/51tyh6y2",
      media_url: "not a url",
    },
    undefined,
    { agent: "scout", userId: ACTOR_USER_ID },
  ), /media_url must be an http/);
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
  // The Notion sync looks rows up by page id.
  assert.deepEqual(validateFilters("app.companies", { notion_page_id: "3fb2faf9-7eb0-8144-b271-c2149101d198" }), [
    { column: "notion_page_id", operator: "eq", value: "3fb2faf9-7eb0-8144-b271-c2149101d198" },
  ]);
  // Meeting lookups by provider code and capture id ride the same machinery.
  assert.deepEqual(validateFilters("transcripts.meetings", { native_id: "abc-defg-hij" }), [
    { column: "native_id", operator: "eq", value: "abc-defg-hij" },
  ]);
  assert.deepEqual(validateFilters("transcripts.meetings", { instance_id: "inst-1" }), [
    { column: "instance_id", operator: "eq", value: "inst-1" },
  ]);
  // The event tracker filters by hosting type, city, and date.
  assert.deepEqual(validateFilters("app.events", { city: "New York", hosted: "hosted", occurred_at_gte: "2026-01-01" }), [
    { column: "city", operator: "eq", value: "New York" },
    { column: "hosted", operator: "eq", value: "hosted" },
    { column: "occurred_at", operator: "gte", value: "2026-01-01" },
  ]);
  // Applications are searched by reviewed columns only; free-text fields such
  // as story are not filterable.
  assert.deepEqual(
    validateFilters("public.applications", { role: "founder", location: "San Francisco", created_at_gte: "2026-01-01" }),
    [
      { column: "role", operator: "eq", value: "founder" },
      { column: "location", operator: "eq", value: "San Francisco" },
      { column: "created_at", operator: "gte", value: "2026-01-01" },
    ],
  );
  assert.throws(() => validateFilters("public.applications", { story: "anything" }), /not filterable/);
  assert.deepEqual(validateFilters("public.host_applications", { city: "San Francisco" }), [
    { column: "city", operator: "eq", value: "San Francisco" },
  ]);
  assert.deepEqual(validateFilters("public.partner_inquiries", { company: "Acme" }), [
    { column: "company", operator: "eq", value: "Acme" },
  ]);
  assert.deepEqual(validateFilters("public.newsletter_subscribers", { email: "a@example.com" }), [
    { column: "email", operator: "eq", value: "a@example.com" },
  ]);
  assert.throws(() => validateFilters("public.newsletter_subscribers", { token: "x" }), /not filterable/);
  assert.throws(() => validateFilters("app.companies", { actor_user: "analyst@houseof434.com" }), /UUID/);
});
