import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { HelloBeat } from "./HelloBeat";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
function render(options?: { hosted?: boolean; sharedWorkspace?: boolean }) {
  let tree: ReactNode = null;
  function Capture() {
    tree = HelloBeat({ ...props, ...options });
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)), tree };
}

beforeEach(() => {
  store.api.mockReset();
  props.onNext.mockReset();
  setLocale("en");
});

describe("the greeting beat", () => {
  it("asks a hosted workspace for nothing and saves nothing", () => {
    const { html, tree } = render({ hosted: true });
    expect(html).not.toContain("<input");
    expect(html).not.toContain("let you know when big things ship");
    expect(html).toContain("shared Relay");
    expect(html).toContain("your administrator manages models");
    // Continue moves on; there is nothing to save
    const primary = nodes(tree).find((node) => typeof node.type === "function" && node.props.onClick);
    primary!.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("keeps the desktop greeting with its name and email fields", () => {
    for (const html of [render().html, render({ hosted: false }).html]) {
      expect(html).toContain("you@example.com");
      expect(html).toContain("let you know when big things ship");
      expect(html).not.toContain("shared Relay");
    }
  });

  it("keeps the shared workspace greeting concise, and asks for nothing", () => {
    const { html, tree } = render({ sharedWorkspace: true });
    expect(html).not.toContain("<input");
    expect(html).not.toContain("you@example.com");
    // the team beat introduces the agents — the greeting stays concise
    for (const agent of ["Scout", "Mercury", "Curator"]) expect(html).not.toContain(agent);
    expect(html).not.toContain("sidebar");
    expect(html).toContain("background tasks");
    // the shared workspace says what to do first, not a bare Continue
    expect(html).toContain("Meet your team");
    const primary = nodes(tree).find((node) => typeof node.type === "function" && node.props.onClick);
    primary!.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("keeps a hosted workspace on its own copy, not the shared one", () => {
    const html = render({ hosted: true, sharedWorkspace: true }).html;
    expect(html).toContain("your administrator manages models");
    expect(html).not.toContain("Meet your team");
  });
});
