import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENTS } from "./domain/permissions.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const init = source("../../../supabase/migrations/0001_init.sql");
const stores = source("../../../supabase/migrations/0002_stores.sql");
const migrations = `${init}\n${stores}`;

// This asserts that the migration files encode the frozen Relay v0.1 data
// model. It does not prove Postgres accepts the SQL or that the constraints and
// RLS policies behave as intended; that only closes once the migrations are
// applied to a real project and exercised.

test("exactly the frozen tables are created", () => {
  const created = [...migrations.matchAll(/create table (\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`);
  assert.deepEqual(created.sort(), [
    "app.companies",
    "app.events",
    "app.people",
    "history.conversations",
    "logs.tool_calls",
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
  assert.doesNotMatch(migrations, /create schema if not exists transcripts/);
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

test("entity tables carry no status column and no promotion gate", () => {
  for (const table of ["companies", "people", "events"]) {
    const definition = new RegExp(`create table app\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(init);
    assert.ok(definition, `app.${table} definition not found`);
    assert.doesNotMatch(definition[1]!, /\bstatus\b/, `app.${table} must not have a status column`);
  }
  // Shared intelligence is visible to every member as soon as it is written.
  assert.equal([...init.matchAll(/using \(classification = 'internal'\)/g)].length, 3);
  assert.doesNotMatch(init, /status = 'active'/);
});

test("tool calls reference a conversation and stay out of member reach", () => {
  assert.match(stores, /conversation_id uuid references history\.conversations\(id\) on delete set null/);
  assert.doesNotMatch(stores, /turn_id/);
  assert.match(stores, /revoke all on all tables in schema logs from public, anon, authenticated/);
  assert.doesNotMatch(stores, /create policy[^;]*on logs\./);
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