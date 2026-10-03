import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ instances: [] as unknown[], dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: { instances: store.instances }, dispatch: store.dispatch }) }));
import { EnginesBeat } from "./EnginesBeat";

const personal = (instanceId: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
});
const company = (ready: boolean): InstanceInfo => ({
  instanceId: "company.fixture.anthropic", driverKind: "claudeAgent", displayName: "Company · Fixture · Claude", readOnly: true,
  managed: { organizationId: "fixture-org", organizationName: "Fixture" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
});
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };

function render(extra: { hosted?: boolean } = {}) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = EnginesBeat({ ...props, ...extra });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html };
}

beforeEach(() => {
  fixture.values = [];
  store.dispatch.mockReset();
  store.instances = [personal("claude", false), personal("codex", false)];
  vi.stubGlobal("window", {});
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engines beat counts", () => {
  it("reports setup counts for personal engines", () => {
    const { html } = render();
    expect(html).toContain("0 ready");
    expect(html).toContain("2 to set up");
    expect(html).not.toContain("Everything is ready");
  });

  it("does not count a Company engine that cannot run yet", () => {
    store.instances = [personal("claude", false), company(false)];
    const html = render().html;
    expect(html).toContain("1 to set up");
    expect(html).not.toContain("Everything is ready");
  });
});
