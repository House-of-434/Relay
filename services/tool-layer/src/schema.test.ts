import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENTS } from "./domain/permissions.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const init = source("../../../supabase/migrations/0001_init.sql");
const stores = source("../../../supabase/migrations/0002_stores.sql");
const ownership = source("../../../supabase/migrations/0004_workspace_ownership.sql");
const transcripts = source("../../../supabase/migrations/0004_transcripts.sql");
const serviceActors = source("../../../supabase/migrations/0005_service_actors.sql");
const migrations = `${init}\n${stores}\n${transcripts}\n${serviceActors}`;

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

test("service actors own meeting rows by UUID, not by a CHECK", () => {
  // The registry is migration/service_role only: RLS on, no policies, no
  // member grant. relay is intentionally absent from pgrst.db_schemas.
  assert.match(serviceActors, /create table if not exists relay\.service_actors \([\s\S]*?unique \(name, actor_user_id\)/);
  assert.match(serviceActors, /alter table relay\.service_actors enable row level security/);
  assert.match(serviceActors, /revoke all on relay\.service_actors from public, anon, authenticated/);
  assert.doesNotMatch(serviceActors, /relay\.service_actors for select to authenticated/);
  // A composite FK with MATCH FULL: actor_agent and actor_user travel together.
  assert.match(
    serviceActors,
    /foreign key \(actor_agent, actor_user\)\s+references relay\.service_actors \(name, actor_user_id\)\s+match full/,
  );
  // Ownership by UUID: generated stored owner, never a CHECK constraint.
  assert.match(
    serviceActors,
    /owner_user_id uuid\s+generated always as \(coalesce\(organizer_user_id, creator_user_id\)\) stored/,
  );
  assert.match(serviceActors, /create index if not exists meetings_owner_user\s+on transcripts\.meetings \(owner_user_id\)/);
  assert.match(serviceActors, /disclosure_posted boolean not null default false/);
  // Terminal states are immutable (active -> partial|failed only).
  assert.match(serviceActors, /create trigger meetings_status_transition/);
  assert.match(serviceActors, /old\.status in \('completed','partial','failed','skipped'\)/);
  // Email -> UUID resolution is service_role only and hardened.
  assert.match(serviceActors, /create or replace function app\.member_by_email\(candidate text, allowed_domains text\[\] default null\)/);
  assert.match(serviceActors, /security definer set search_path = ''/);
  assert.match(serviceActors, /u\.email_confirmed_at is not null/);
  assert.match(serviceActors, /grant execute on function app\.member_by_email\(text, text\[\]\) to service_role/);
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