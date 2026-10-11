import assert from "node:assert/strict";
import test from "node:test";

import { labelsForTiles, litLabels } from "./gmeet-labels.js";

test("unique names keep their name; self and unnamed tiles get no label", () => {
  const labels = labelsForTiles([
    { id: "p1", name: "Alice", self: false },
    { id: "p2", name: "Bob", self: false },
    { id: "me", name: "Host", self: true },
    { id: "p3", name: null, self: false },
  ]);
  assert.equal(labels.get("p1"), "Alice");
  assert.equal(labels.get("p2"), "Bob");
  assert.equal(labels.has("me"), false);
  assert.equal(labels.has("p3"), false);
});

test("duplicate display names are disambiguated by tile id, never merged", () => {
  // Two people both named "Dana": the first (by id) keeps the name, the second
  // becomes "Dana (2)" — a WRONG merged name is never produced.
  const labels = labelsForTiles([
    { id: "p10", name: "Dana", self: false },
    { id: "p2", name: "Dana", self: false },
    { id: "p7", name: "Dana", self: false },
  ]);
  // ordered by participant id lexicographically: p10 < p2 < p7
  assert.equal(labels.get("p10"), "Dana");
  assert.equal(labels.get("p2"), "Dana (2)");
  assert.equal(labels.get("p7"), "Dana (3)");
  assert.equal(new Set(labels.values()).size, 3);
});

test("labels are stable regardless of tile order in the scan", () => {
  const a = labelsForTiles([
    { id: "p2", name: "Dana", self: false },
    { id: "p10", name: "Dana", self: false },
  ]);
  const b = labelsForTiles([
    { id: "p10", name: "Dana", self: false },
    { id: "p2", name: "Dana", self: false },
  ]);
  assert.deepEqual(Object.fromEntries(a), Object.fromEntries(b));
});

test("litLabels reports only non-self, named, speaking tiles", () => {
  const tiles = [
    { id: "p1", name: "Alice", self: false, speaking: true },
    { id: "p2", name: "Bob", self: false, speaking: false },
    { id: "me", name: "Host", self: true, speaking: true },
    { id: "p3", name: null, self: false, speaking: true },
  ];
  const labels = labelsForTiles(tiles);
  assert.deepEqual(litLabels(tiles, labels), ["Alice"]);
});
