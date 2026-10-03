import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("entity ownership columns and authenticated RLS policies use UUID JWT subjects", () => {
  const init = source("../../../supabase/migrations/0001_init.sql");
  const stores = source("../../../supabase/migrations/0002_stores.sql");

  assert.equal([...init.matchAll(/actor_user\s+uuid\b/g)].length, 3);
  assert.doesNotMatch(init, /actor_user\s+text\b/);
  assert.doesNotMatch(init, /auth\.jwt\(\)\s*->>\s*'email'/);

  assert.match(stores, /user_id\s+uuid not null/);
  assert.match(stores, /user_id = \(auth\.jwt\(\) ->> 'sub'\)::uuid/);
  assert.doesNotMatch(stores, /auth\.jwt\(\)\s*->>\s*'email'/);
});

test("active identity contexts do not use email-named identity fields", () => {
  for (const path of [
    "./infra/database.ts",
    "./domain/shapes.ts",
    "./index.ts",
    "../../../server/relay-mcp.ts",
    "../../../server/index.ts",
    "../../../shared/wire.ts",
  ]) {
    assert.doesNotMatch(source(path), /\b(?:userEmail|actorEmail)\b/, path);
  }
});