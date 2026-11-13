import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  const view = { current: "computer" };
  vi.stubGlobal("localStorage", { getItem: () => view.current });
  return { config: {} as FeatureFlagConfig & { cloudHome?: boolean }, view };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { config: { box: { configured: false }, ...fixture.config }, instances: [], computerControl: {}, routines: [], routineRuns: [] },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
  }),
}));
import { ComputerPanel } from "./ComputerPanel";

afterAll(() => vi.unstubAllGlobals());
const bot = { id: "computer-fixture", name: "Computer fixture", modelSelection: { instanceId: "fixture" } } as Bot;
const render = (config: FeatureFlagConfig & { cloudHome?: boolean }) => {
  fixture.config = config;
  return renderToStaticMarkup(createElement(ComputerPanel, { bot }));
};

describe("Computer panel on a narrow screen", () => {
  it("covers the window below md instead of docking a 400px column", () => {
    // A phone reaches this panel through the browser (remote access). Docked
    // at its stored width it pushed the chat to zero and ran off the right
    // edge, where `body { overflow: hidden }` cut it off. Below md it takes
    // the window like the settings and inspector panels do; the inline width
    // still sizes it beside the chat on wider screens.
    const markup = render({});
    const aside = /<aside class="([^"]*)"/.exec(markup)!;
    expect(aside[1].split(" ")).toEqual(expect.arrayContaining(["max-md:absolute", "max-md:inset-0", "max-md:z-40", "max-md:w-full!"]));
    // Nothing to drag against when the panel is the whole window.
    const separator = /<div role="separator"[^>]*class="([^"]*)"/.exec(markup)!;
    expect(separator[1].split(" ")).toContain("max-md:hidden");
  });
});

describe("Computer panel destination picker", () => {
  it("no longer shows the Works on destination picker", () => {
    fixture.view.current = "computer";
    const markup = render({});
    expect(markup).not.toContain("Choose where this bot can use a computer.</p>");
    expect(markup).not.toMatch(/<span>(Auto|Cloud|Local VM|This computer|Off)<\/span>/);
  });
});
