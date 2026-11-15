import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config ?? original.initialState.config }, dispatch: fixture.dispatch }) };
});

// DesktopCapabilities reads `window.ogb` at module scope for its context
// default; the src test suite runs under vitest's "node" environment (no
// window), so it must be stubbed the same way SidebarBotListItem.test.ts does.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));

const { AccessSection } = await import("./AccessSection");

// WorkingFolder (moved into this file) reads window.ogb?.pickFolder directly
// at render time, same "node" environment gap as above — stub per test, the
// way desktop.test.ts and EngineUpdateNotice.test.ts do.
beforeEach(() => { vi.stubGlobal("window", {}); fixture.dispatch.mockReset(); fixture.config = null; });
afterEach(() => vi.unstubAllGlobals());

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "Scout",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function render(bot: Bot) {
  return renderToStaticMarkup(
    createElement(StoreProvider, null, createElement(AccessSection, { bot })),
  );
}

describe("AccessSection always-allowed list", () => {
  it("shows a placeholder when nothing is standing yet", () => {
    const markup = render(makeBot());
    expect(markup).toContain("Nothing standing yet.");
  });

  it("lists each always-allowed entry with a Remove button", () => {
    const markup = render(makeBot({ alwaysAllow: ["shell.run", "fs.write"] }));
    expect(markup).toContain("shell.run");
    expect(markup).toContain("fs.write");
    expect(markup).toContain('aria-label="Remove shell.run from always allowed"');
    expect(markup).toContain('aria-label="Remove fs.write from always allowed"');
    expect(markup).not.toContain("Nothing standing yet.");
  });
});

describe("AccessSection computer picker", () => {
  it("no longer shows the Works on picker", () => {
    const markup = render(makeBot());
    expect(markup).not.toContain("Works on");
    expect(markup).not.toMatch(/>(Auto|Cloud|Local VM|This computer|Off)<\/button>/);
  });
});
