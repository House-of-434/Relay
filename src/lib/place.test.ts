import { describe, expect, it } from "vitest";
import { placeLabelKey, toolPlace } from "./place";
import { toolSurfaceKind } from "../../shared/tool-surface";

describe("tool places", () => {
  it("names the browser with one label key", () => {
    expect(placeLabelKey("browser")).toBe("place.browser");
  });

  it("gives browser tools the browser and other tools nothing", () => {
    expect(toolPlace("agent_browser_snapshot")).toBe("browser");
    expect(toolPlace("mcp__browser__browser_click")).toBe("browser");
    for (const name of ["Bash", "Read", "list_bots", "recall", "screenshot", "click"]) {
      expect(toolPlace(name), name).toBeNull();
    }
  });

  it("classifies tool names without guessing a computer for unrelated tools", () => {
    expect(toolSurfaceKind("agent_browser_open")).toBe("browser");
    expect(toolSurfaceKind("browser__snapshot")).toBe("browser");
    expect(toolSurfaceKind("Bash")).toBeNull();
    expect(toolSurfaceKind("mcp__agents__list_bots")).toBeNull();
  });
});
