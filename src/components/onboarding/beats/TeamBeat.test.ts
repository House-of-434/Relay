import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ state: { bots: [] as unknown[] } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: store.state, dispatch: vi.fn() }) }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: ({ label }: { label?: string }) => createElement("span", { "aria-label": label }) }));
import { TeamBeat } from "./TeamBeat";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

const scout = { id: "a", name: "Scout", title: "Research", description: "Research companies and people.", color: "blue" };
const mercury = { id: "b", name: "Mercury", title: "Inbox & Calendar", description: "Triage Gmail.", color: "orange" };

function render(bots: unknown[]) {
  store.state = { bots };
  let tree: ReactNode = null;
  function Capture() {
    tree = TeamBeat({ onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, tree };
}

beforeEach(() => setLocale("en"));

describe("the roster beat", () => {
  it("walks the sidebar's agents, each with its role and what it does", () => {
    const { html } = render([scout, mercury]);
    for (const agent of [scout, mercury]) {
      expect(html).toContain(agent.name);
      // the rendered markup escapes the ampersand in Mercury's role line
      expect(html).toContain(agent.title.replace("&", "&amp;"));
      expect(html).toContain(agent.description);
    }
    // the beat's own line; its heading is WelcomeFlow's, and is tested there
    expect(html).toContain("Everyone in the sidebar is a real agent");
  });

  it("labels each agent for a screen reader", () => {
    expect(render([scout, mercury]).html).toContain('aria-label="Scout"');
  });

  it("does not introduce a bot the person hid", () => {
    const { html } = render([scout, { ...mercury, hidden: true }]);
    expect(html).toContain("Scout");
    expect(html).not.toContain("Mercury");
  });

  it("still offers a way forward when the workspace has no agents yet", () => {
    const { html, tree } = render([]);
    expect(html).toContain("No agents have been added");
    const primary = nodes(tree).find((node) => node.props.onClick);
    expect(primary).toBeTruthy();
  });

  it("renders a bot with no title or description without breaking", () => {
    const html = render([{ id: "z", name: "New bot", color: "green" }]).html;
    expect(html).toContain("New bot");
  });
});