import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENTS } from "./domain/permissions.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const init = source("../../../supabase/migrations/0001_init.sql");
const stores = source("../../../supabase/migrations/0002_stores.sql");
const ownership = source("../../../supabase/migrations/0004_workspace_ownership.sql");
const transcripts = source("../../../supabase/migrations/0006_transcripts.sql");
const serviceActors = source("../../../supabase/migrations/0007_service_actors.sql");
const notionMirror = source("../../../supabase/migrations/0009_mirror_notion_deals.sql");
const migrations = `${init}\n${stores}\n${ownership}\n${transcripts}\n${serviceActors}`;

// This asserts that the migration files encode the frozen Relay v0.1 data
// model. It does not prove Postgres accepts the SQL or that the constraints and
// RLS policies behave as intended; that only closes once the migrations are
// applied to a real project and exercised.

test("exactly the frozen tables are created", () => {
  const created = [...migrations.matchAll(/create table (?:if not exists )?(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`);
  assert.deepEqual(created.sort(), [
    "app.companies",
    "app.events",
    "app.people",
    "history.conversations",
    "logs.tool_calls",
    "relay.service_actors",
    "transcripts.meeting_segments",
    "transcripts.meetings",
  ]);
});

test("deliberately deferred tables and workflows are absent", () => {
  for (const table of [
    "app.captures",
    "logs.turns",
    "logs.monthly_spend",
    "transcripts.email_threads",
    "history.generated_docs",
  ]) {
    assert.doesNotMatch(migrations, new RegExp(`create (?:table|view) ${table.replace(".", "\\.")}\\b`), table);
  }
  assert.doesNotMatch(migrations, /create table \w+\.(agent_runs|messages)\b/);
  assert.doesNotMatch(migrations, /capture_entity_provenance|activate_entity_after_capture/);
  // No approval or promotion step remains anywhere in the schema.
  assert.doesNotMatch(migrations, /\bapproveSuggestion\b|\bsuggestion\b/);
});

test("conversation agent enum matches the agents the Tool Layer serves", () => {
  const match = /agent\s+text not null\s+check \(agent in \(([^)]*)\)\)/.exec(stores);
  assert.ok(match, "history.conversations.agent must be a checked enum");
  const sqlAgents = match[1]!.split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(sqlAgents, [...AGENTS]);
});

test("conversation lifecycle is idle, running, or failed", () => {
  assert.match(
    stores,
    /status\s+text not null default 'idle'\s+check \(status in \('idle','running','failed'\)\)/,
  );
  assert.doesNotMatch(stores, /'completed'/);
});

test("the base entity tables carry no status column or promotion gate; the mirrored pipeline status arrives via 0009", () => {
  for (const table of ["companies", "people", "events"]) {
    const definition = new RegExp(`create table app\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(init);
    assert.ok(definition, `app.${table} definition not found`);
    assert.doesNotMatch(definition[1]!, /\bstatus\b/, `app.${table} must not have a status column in the base model`);
  }
  // Shared intelligence is visible to every member as soon as it is written.
  assert.equal([...init.matchAll(/using \(classification = 'internal'\)/g)].length, 3);
  assert.doesNotMatch(init, /status = 'active'/);
  // The Notion deal mirror adds a plain pipeline status to companies only; it
  // is a board field, not an internal promotion gate.
  assert.match(notionMirror, /alter table app\.companies\s+add column if not exists status\s+text/);
  assert.doesNotMatch(notionMirror, /\bstatus\s+text not null\b/);
});

test("tool calls reference a conversation and stay out of member reach", () => {
  assert.match(stores, /conversation_id uuid references history\.conversations\(id\) on delete set null/);
  assert.doesNotMatch(stores, /turn_id/);
  assert.match(stores, /revoke all on all tables in schema logs from public, anon, authenticated/);
  assert.doesNotMatch(stores, /create policy[^;]*on logs\./);
});

test("per-user ownership columns are stamped on the frozen tables", () => {
  for (const table of ["companies", "people", "events"]) {
    assert.match(ownership, new RegExp(`alter table app\\.${table} add column if not exists owner_user_id uuid`), table);
    assert.match(ownership, new RegExp(`alter table app\\.${table} add column if not exists scope text not null default 'private'`), table);
  }
  assert.match(ownership, /alter table history\.conversations add column if not exists bot_id uuid/);
  assert.match(ownership, /alter table history\.conversations add column if not exists thread_id uuid/);
  // The backfill is documented but not run: new rows default to private.
  assert.match(ownership, /update app\.companies set scope = 'org'/);
});

test("PostgREST exposes only the three Relay schemas", () => {
  assert.match(stores, /pgrst\.db_schemas = 'public,app,logs,history'/);
});

test("members are read-only and the Tool Layer is the only elevated writer", () => {
  assert.match(
    stores,
    /revoke insert, update, delete, truncate, references, trigger\s+on all tables in schema app, history from public, anon, authenticated/,
  );
  assert.match(stores, /grant all privileges on all tables in schema app, logs, history to service_role/);
});