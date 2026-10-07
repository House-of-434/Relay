import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearThreadOwnerCache, inheritThreadOwner, recordThreadOwner, threadOwner } from "./thread-owners.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thread-owners-"));
  clearThreadOwnerCache(dir);
  return dir;
}

describe("thread owners", () => {
  it("records and returns a new owner", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "thread-1", USER_A, "a@houseof434.com")).toBe(true);
    expect(threadOwner(dir, "thread-1")).toEqual({
      userId: USER_A,
      email: "a@houseof434.com",
      at: expect.any(Number),
    });
  });

  it("first-writer-wins: a later sender cannot steal a thread", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "thread-1", USER_A)).toBe(true);
    expect(recordThreadOwner(dir, "thread-1", USER_B, "b@houseof434.com")).toBe(false);
    expect(threadOwner(dir, "thread-1")?.userId).toBe(USER_A);
  });

  it("rejects non-UUID user ids without recording", () => {
    const dir = freshDir();
    for (const bad of [undefined, "", "not-a-uuid", "user:abc", "USER_A"]) {
      expect(recordThreadOwner(dir, "thread-1", bad as string)).toBe(false);
    }
    expect(threadOwner(dir, "thread-1")).toBeUndefined();
  });

  it("rejects empty thread ids", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "", USER_A)).toBe(false);
  });

  it("persists to disk and survives a cache clear", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "thread-1", USER_A, "a@houseof434.com")).toBe(true);
    clearThreadOwnerCache(dir);
    expect(threadOwner(dir, "thread-1")?.userId).toBe(USER_A);
    const saved = JSON.parse(readFileSync(join(dir, "thread-owners.json"), "utf8"));
    expect(saved["thread-1"].userId).toBe(USER_A);
  });

  it("tolerates a corrupt file and can still record", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "thread-owners.json"), "not json{{{");
    expect(threadOwner(dir, "thread-1")).toBeUndefined();
    expect(recordThreadOwner(dir, "thread-1", USER_A)).toBe(true);
    expect(threadOwner(dir, "thread-1")?.userId).toBe(USER_A);
  });

  it("skips corrupt rows without trusting them", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "thread-owners.json"),
      JSON.stringify({
        good: { userId: USER_A, at: 1 },
        forged: { userId: "attacker", at: 2 },
        shapeless: "nope",
      }),
    );
    expect(threadOwner(dir, "good")?.userId).toBe(USER_A);
    expect(threadOwner(dir, "forged")).toBeUndefined();
    expect(threadOwner(dir, "shapeless")).toBeUndefined();
  });

  it("omits email when the sender carried none", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "thread-1", USER_A)).toBe(true);
    expect(threadOwner(dir, "thread-1")).toEqual({
      userId: USER_A,
      at: expect.any(Number),
    });
  });
});

describe("thread owner inheritance", () => {
  it("a child inherits its owned parent's owner", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "parent", USER_A, "a@houseof434.com")).toBe(true);
    expect(inheritThreadOwner(dir, "parent", "child")).toBe(true);
    expect(threadOwner(dir, "child")).toEqual({
      userId: USER_A,
      email: "a@houseof434.com",
      at: expect.any(Number),
    });
  });

  it("a child of an ownerless parent stays ownerless", () => {
    const dir = freshDir();
    expect(inheritThreadOwner(dir, "parent", "child")).toBe(false);
    expect(threadOwner(dir, "child")).toBeUndefined();
  });

  it("does not overwrite an already-owned child", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "parent", USER_A)).toBe(true);
    expect(recordThreadOwner(dir, "child", USER_B)).toBe(true);
    expect(inheritThreadOwner(dir, "parent", "child")).toBe(false);
    expect(threadOwner(dir, "child")?.userId).toBe(USER_B);
  });

  it("refuses self-inheritance and empty ids", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "parent", USER_A)).toBe(true);
    expect(inheritThreadOwner(dir, "parent", "parent")).toBe(false);
    expect(inheritThreadOwner(dir, "", "child")).toBe(false);
    expect(inheritThreadOwner(dir, "parent", "")).toBe(false);
  });

  it("the inherited record persists, not just the cache", () => {
    const dir = freshDir();
    expect(recordThreadOwner(dir, "parent", USER_A, "a@houseof434.com")).toBe(true);
    expect(inheritThreadOwner(dir, "parent", "child")).toBe(true);
    clearThreadOwnerCache(dir);
    expect(threadOwner(dir, "child")).toEqual({
      userId: USER_A,
      email: "a@houseof434.com",
      at: expect.any(Number),
    });
  });
});
