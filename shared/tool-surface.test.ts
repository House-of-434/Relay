import { describe, expect, it } from "vitest";

import { toolSurfaceKind } from "./tool-surface";

describe("research browser classification", () => {
  it("places relay browser tools on the browser surface", () => {
    expect(toolSurfaceKind("browser_open")).toBe("browser");
    expect(toolSurfaceKind("mcp__browser__browser_open")).toBe("browser");
    expect(toolSurfaceKind("browser_extract")).toBe("browser");
  });

  it("keeps read-only observation and unrelated calls off any surface", () => {
    expect(toolSurfaceKind("web_search")).toBe(null);
    expect(toolSurfaceKind("relay_read")).toBe(null);
    expect(toolSurfaceKind("Bash")).toBe(null);
    expect(toolSurfaceKind("click")).toBe(null);
  });
});
