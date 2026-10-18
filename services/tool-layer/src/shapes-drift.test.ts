import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { SHAPES } from "./domain/shapes.js";

/** Every migration in order, so the column set reflects added and dropped
 * columns, not just the create-table baseline. */
const migrationsDir = new URL("../../../supabase/migrations/", import.meta.url);
const allSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), "utf8"))
  .join("\n");

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const NON_COLUMN_LINE = new Set(["constraint", "unique", "primary", "check", "foreign", "exclude", "like"]);

/**
 * The columns a table ends up with across every migration. Deliberately strict:
 * a statement that touches the table but does not look like recognized column
 * DDL throws, so a new migration form cannot slip past the drift check and
 * leave SHAPES silently out of step with the database.
 */
function columnsFor(sqlText: string, table: string): Set<string> {
  const escaped = table.replace(".", "\\.");
  const columns = new Set<string>();

  const create = new RegExp(`create table (?:if not exists )?${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*;`, "i").exec(sqlText);
  if (create) {
    for (const rawLine of create[1]!.split("\n")) {
      const line = rawLine.replace(/--.*$/, "").trim();
      if (!line) continue;
      const first = line.split(/\s+/)[0]!.toLowerCase();
      if (NON_COLUMN_LINE.has(first)) continue;
      const name = /^([a-z_][a-z0-9_]*)\s/i.exec(line)?.[1];
      if (!name || !IDENTIFIER.test(name)) throw new Error(`unsupported column DDL for ${table}: ${line}`);
      columns.add(name);
    }
  }

  const alters = sqlText.match(new RegExp(`alter table (?:if exists )?${escaped}\\b[^;]*;`, "gi")) ?? [];
  for (const statement of alters) {
    const normalized = statement.replace(/\s+/g, " ").trim();
    const added = [...normalized.matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]!);
    if (added.length) {
      for (const column of added) columns.add(column);
      continue;
    }
    const dropped = [...normalized.matchAll(/drop column (?:if exists )?([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]!);
    if (dropped.length) {
      for (const column of dropped) columns.delete(column);
      continue;
    }
    // Non-column table alters are allowed: constraints, RLS toggles, ownership.
    if (/\b(add|drop) constraint\b/i.test(normalized)) continue;
    if (/\b(enable|disable|force|no force) row level security\b/i.test(normalized)) continue;
    if (/\balter column\b/i.test(normalized)) continue;
    if (/\bowner to\b/i.test(normalized)) continue;
    throw new Error(`unsupported migration DDL touching ${table}: ${normalized}`);
  }

  return columns;
}

const driftTables = Object.keys(SHAPES).filter((table) => table.startsWith("app."));

for (const table of driftTables) {
  test(`shape for ${table} accounts for every migration column`, () => {
    const shape = SHAPES[table]!;
    const columns = columnsFor(allSql, table);
    const declared = new Set<string>([...shape.writable, ...shape.serverSet, shape.updateKey ?? "id"]);

    assert.deepEqual(
      [...columns].filter((column) => !declared.has(column)).sort(),
      [],
      `${table}: migration columns missing from the shape`,
    );
    assert.deepEqual(
      [...declared].filter((column) => !columns.has(column)).sort(),
      [],
      `${table}: the shape names columns the migrations do not create`,
    );
    assert.deepEqual(
      shape.writable.filter((column) => shape.serverSet.includes(column)),
      [],
      `${table}: writable and serverSet must not overlap`,
    );

    const referenced = [
      ...shape.require.map((entry) => entry.f),
      ...(shape.validate ?? []).map((entry) => entry.f),
      ...shape.filterable,
    ];
    for (const field of referenced) {
      assert.ok(columns.has(field), `${table}: ${field} is referenced but is not a column`);
    }
  });
}

test("the drift check fails closed on migration DDL it does not understand", () => {
  // A future migration form must surface as a failure, not a silent pass, so
  // the shape can never drift from the database unnoticed.
  assert.throws(
    () => columnsFor("alter table app.companies set (fillfactor = 70);", "app.companies"),
    /unsupported migration DDL/,
  );
  assert.throws(
    () => columnsFor("alter table app.companies rename column name to title;", "app.companies"),
    /unsupported migration DDL/,
  );
  assert.throws(
    () => columnsFor('create table app.companies (\n  "name" text\n);', "app.companies"),
    /unsupported column DDL/,
  );
});
