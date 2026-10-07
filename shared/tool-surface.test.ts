import { describe, expect, it } from "vitest";

import { screenSurfaceForTool, screenTouchingTool, toolSurfaceKind } from "./tool-surface";

describe("research browser classification", () => {
  it("treats navigations and extractions as screen-touching", () => {
    expect(screenTouchingTool("browser_open")).toBe(true);
    expect(screenTouchingTool("browser_extract")).toBe(true);
    expect(screenTouchingTool("mcp__relay-scout__browser_open")).toBe(true);
  });

  it("keeps reads out, like every other read-only observation call", () => {
    expect(screenTouchingTool("browser_read")).toBe(false);
    expect(screenTouchingTool("web_search")).toBe(false);
    expect(screenTouchingTool("relay_read")).toBe(false);
  });

  it("places relay browser tools on the browser surface", () => {
    expect(screenSurfaceForTool("browser_open")).toBe("browser");
    expect(screenSurfaceForTool("mcp__relay-scout__browser_extract")).toBe("browser");
    expect(toolSurfaceKind("browser_open")).toBe("browser");
    expect(toolSurfaceKind("web_search")).toBe(null);
  });
});
