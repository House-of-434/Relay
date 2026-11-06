import { describe, it, expect } from "vitest";
import { relayLibrary } from "./library.ts";
import { openUIPrompt } from "../openui-meta/library-meta.ts";
import { componentDefinitions } from "./definitions.ts";

describe("OpenUI prompt contract", () => {
  it("prompt length is under 2000 chars", () => {
    expect(openUIPrompt.length).toBeLessThan(2600);
  });

  it("prompt contains all registered components", () => {
    for (const def of componentDefinitions) {
      expect(openUIPrompt).toContain(def.name);
    }
  });

  it("prompt does not reference fictional Root component", () => {
    expect(openUIPrompt).not.toMatch(/\bRoot\b/);
  });

  it("prompt contains syntax rules", () => {
    expect(openUIPrompt).toContain("identifier = Expression");
    expect(openUIPrompt).toContain("root");
    expect(openUIPrompt).toContain("positional");
  });

  it("prompt contains an example", () => {
    expect(openUIPrompt).toContain("root = Stack");
    expect(openUIPrompt).toContain("Badge");
    expect(openUIPrompt).toContain("Callout");
  });

  it("prompt contains duplicate heading guidance", () => {
    expect(openUIPrompt).toContain("Card should own the section heading");
  });

  it("prompt contains duplicate data guidance", () => {
    expect(openUIPrompt).toContain("do not duplicate the same data in a Markdown table");
  });

  it("prompt does not contain hoisting/streaming internals", () => {
    expect(openUIPrompt).not.toContain("hoisting");
    expect(openUIPrompt).not.toContain("progressive top-down reveal");
    expect(openUIPrompt).not.toContain("Final Verification");
  });

  it("all components in library are in definitions", () => {
    const libComponents = Object.keys(relayLibrary.components);
    const defNames = componentDefinitions.map((d) => d.name);
    for (const name of libComponents) {
      expect(defNames).toContain(name);
    }
  });

  it("all definitions are in library", () => {
    const libComponents = Object.keys(relayLibrary.components);
    for (const def of componentDefinitions) {
      expect(libComponents).toContain(def.name);
    }
  });
});
