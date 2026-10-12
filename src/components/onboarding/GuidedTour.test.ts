import { createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUR_STEPS } from "@/lib/guided-tour";
import { EMPTY_ONBOARDING, WELCOME_VERSION } from "@/lib/onboarding";
import { readTourSeen, writeTourSeen } from "@/lib/first-run";

// The same shape as the other onboarding tests: render the component by hand,
// collect effects, and run them in order.
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
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: store.state, dispatch: store.dispatch }) }));
// the browser's own one-time gate, as the welcome flow leaves it
const gate = vi.hoisted(() => ({ done: false }));
vi.mock("@/lib/first-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/first-run")>()),
  emailGateDone: () => gate.done,
}));
// The real Spotlight portals onto the document; stand in for it with a node
// that renders its copy, so a step's text and progress can be asserted.
vi.mock("./Spotlight", () => ({
  Spotlight: ({ children, progress, primary }: { children?: ReactNode; progress?: string; primary?: { label: string } }) =>
    createElement("div", null, progress ?? "", children, primary?.label ?? ""),
}));
import { GuidedTour } from "./GuidedTour";

// The tree is whatever the component returned; the cast below is only ever
// applied after a test has established a spotlight was rendered.
type SpotlightNode = ReactElement<{ primary: { label: string; onClick: () => void } }>;
const spotlight = (value: ReactNode): SpotlightNode => {
  if (!isValidElement(value)) throw new Error("expected a spotlight on screen");
  return value as SpotlightNode;
};

function render() {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = GuidedTour();
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  // effects run after render, in order, as they would in the browser
  for (const effect of fixture.effects.splice(0)) effect();
  return { html, tree };
}

const DONE = { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-10-01T00:00:00.000Z", version: WELCOME_VERSION } };
const refused = () => Promise.reject(new Error("forbidden"));

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.effects = [];
  gate.done = false;
  store.api.mockReset();
  store.dispatch.mockReset();
  store.state = { config: { onboarding: EMPTY_ONBOARDING }, welcomeOpen: false, tourOpen: true };
  vi.stubGlobal("localStorage", browserStorage());
  vi.stubGlobal("window", {});
  // the tour listens for a click on the control it points at
  // no anchor is ever on screen here, so a step that needs one skips itself
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    activeElement: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function browserStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("the guided tour on the live interface", () => {
  it("stays closed until the welcome flow is done", () => {
    expect(render().tree).toBeNull();
  });

  it("opens on the first step once the workspace record says the welcome is done", () => {
    store.state = { ...store.state, config: DONE };
    const { tree } = render();
    expect(tree).not.toBeNull();
  });

  it("opens for a member whose only welcome record is the browser's own gate", () => {
    // exactly Relay's shared workspace: the config write is admin-only and
    // never lands, so completedAt stays empty
    gate.done = true;
    expect(render().tree).not.toBeNull();
  });

  it("closes itself for good once this browser has seen every step", () => {
    for (const step of TOUR_STEPS) writeTourSeen(localStorage, step.id);
    gate.done = true;
    store.state = { ...store.state, config: DONE };
    expect(render().tree).toBeNull();
  });

  it("resumes at the step this browser has not reached, past the server's record", () => {
    // the server knows the first step; this browser is further along
    store.state = {
      ...store.state,
      config: { onboarding: { ...EMPTY_ONBOARDING, hintsSeen: ["tour.composer"], completedAt: DONE.onboarding.completedAt, version: WELCOME_VERSION } },
    };
    writeTourSeen(localStorage, "tour.tools");
    const { html } = render();
    // step 3 of 6 is the apps step; the composer and tools steps are behind us
    expect(html).toContain("Step 3 of 6");
  });

  it("records a step in the browser when the workspace refuses the write", async () => {
    gate.done = true;
    store.api.mockReturnValue(refused());
    const first = spotlight(render().tree);
    expect(first.props.primary.label).toBe("Next");
    first.props.primary.onClick();
    await flush();
    expect(readTourSeen(localStorage)).toEqual(["tour.composer"]);
  });

  it("still writes to the workspace when it can", async () => {
    store.state = { ...store.state, config: DONE };
    store.api.mockReturnValue(Promise.resolve(DONE));
    spotlight(render().tree).props.primary.onClick();
    await flush();
    expect(store.api).toHaveBeenCalledOnce();
    const body = JSON.parse((store.api.mock.calls[0]![1] as { body: string }).body);
    expect(body.onboarding.hintsSeen).toEqual(["tour.composer"]);
  });
});
