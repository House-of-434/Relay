import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BORING_VARIANTS,
  boringPattern,
  boringSeed,
  boringVariantFor,
  paletteFor,
} from "./boring-patterns";

const COLORS = paletteFor("#009957");

describe("boringSeed", () => {
  it("prefers the stable id over the name", () => {
    expect(boringSeed({ id: "bot-7", name: "Atlas" })).toBe("bot-7");
  });

  it("falls back to the name for a synthetic profile with no id", () => {
    expect(boringSeed({ name: "Scout" })).toBe("Scout");
  });

  it("ignores blank ids so a rename still holds the same seed", () => {
    expect(boringSeed({ id: "  ", name: "Atlas" })).toBe("Atlas");
  });
});

describe("paletteFor", () => {
  it("returns five valid hex colors", () => {
    expect(COLORS).toHaveLength(5);
    for (const color of COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is deterministic", () => {
    expect(paletteFor("#009957")).toEqual(paletteFor("#009957"));
  });

  it("varies the hues so patterns are not single-hue mud", () => {
    expect(new Set(COLORS).size).toBeGreaterThan(2);
  });
});

describe("variant selection", () => {
  it("only offers animated, blur-free variants", () => {
    expect(BORING_VARIANTS).not.toContain("marble");
  });

  it("always returns a known variant", () => {
    for (const seed of ["a", "atlas", "bot-1", "", "🔭"]) {
      expect(BORING_VARIANTS).toContain(boringVariantFor(seed));
    }
  });
});

describe("boringPattern", () => {
  it("is deterministic for the same seed and colors", () => {
    const a = boringPattern({ seed: "atlas", colors: COLORS, variant: "pixel" });
    const b = boringPattern({ seed: "atlas", colors: COLORS, variant: "pixel" });
    expect(a).toEqual(b);
  });

  it("changes the drawing when the seed changes", () => {
    const a = boringPattern({ seed: "atlas", colors: COLORS, variant: "pixel" });
    const b = boringPattern({ seed: "scout", colors: COLORS, variant: "pixel" });
    expect(a.markup).not.toBe(b.markup);
  });


  it("draws every variant without a blur filter", () => {
    for (const variant of BORING_VARIANTS) {
      const { markup } = boringPattern({ seed: "atlas", colors: COLORS, variant });
      expect(markup).not.toContain("feGaussianBlur");
      expect(markup.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Consistency guard: a bot that exists in state must reach BotAvatar intact so
 * its avatar seeds on the stable id. The only inline object literal allowed is
 * the `??` fallback for a peer that genuinely isn't in state (no id exists).
 */
describe("BotAvatar call sites", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) return walk(path);
      return entry.endsWith(".tsx") && !entry.endsWith(".test.tsx") ? [path] : [];
    });

  it("only passes an id-less literal as a fallback", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (/BotAvatar[^\n]*bot=\{\{/.test(line) && !line.includes("??")) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
