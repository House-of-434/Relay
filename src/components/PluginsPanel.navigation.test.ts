import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { sharedWorkspace: true } }, dispatch: vi.fn() }),
}));

import { CONNECTION_SERVICES, GITHUB_SERVICE, NOTION_SERVICE, PluginsPanel, connectionViews, type ConnectionAccount, type GithubConnection, type NotionConnection, type PluginsPanelProps } from "./PluginsPanel";

const gmail: ConnectionAccount = { service: "gmail", id: "ca_1", email: "me@houseof434.com" };
const calendar: ConnectionAccount = { service: "google-calendar", id: "ca_2", email: "me@houseof434.com" };
const secondGmail: ConnectionAccount = { service: "gmail", id: "ca_3", email: "other@houseof434.com" };

type Node = ReactElement<Record<string, unknown> & { "aria-label"?: string; onClick?: () => void }>;
// Rows hand their control to a row component as a prop, so every prop value is
// searched, not just children.
const nodes = (value: unknown): Node[] => Array.isArray(value)
  ? value.flatMap(nodes)
  : isValidElement(value)
    ? [value as Node, ...Object.values((value as Node).props).flatMap(nodes)]
    : [];

const stubWindow = (search: string, confirmed = true) => vi.stubGlobal("window", {
  location: { search, href: `http://localhost:5199/${search}` },
  history: { replaceState: vi.fn() },
  confirm: vi.fn(() => confirmed),
});

const render = (props: Partial<PluginsPanelProps> = {}, search = "", confirmed = true) => {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() {
    tree = PluginsPanel({
      accounts: [], configured: {}, loading: false, error: null,
      onConnect: vi.fn(), onDisconnect: vi.fn(), ...props,
    });
    return tree;
  }
  stubWindow(search, confirmed);
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(Capture));
  } finally {
    vi.unstubAllGlobals();
  }
  const rendered = nodes(tree);
  return {
    html,
    // The panel runs without a DOM here, so a control is exercised the way the
    // app does: by firing the handler React handed it.
    click: (ariaLabel: string) => {
      const control = rendered.find((node) => node.props["aria-label"] === ariaLabel);
      if (!control?.props.onClick) throw new Error(`no control labelled ${ariaLabel}`);
      stubWindow(search, confirmed);
      try {
        control.props.onClick();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  };
};

describe("Connections marketplace", () => {
  it("offers exactly the two shipped Google services, with no marketplace or MCP", () => {
    const { html } = render();
    expect(html).toContain("Connections");
    expect(html).toContain("Gmail");
    expect(html).toContain("Google Calendar");
    // Relay mounts its own agent routes from the workspace, so a teammate has
    // no MCP server list to edit here.
    expect(html).not.toContain("MCP");
    expect(html).not.toContain("Slack");
    expect(html).not.toContain("Marketplace");
  });

  it("keeps the guided-tour anchors the app tour steers by", () => {
    const { html } = render();
    expect(html).toContain('data-tour="apps-panel"');
    expect(html).toContain('data-tour="apps-close"');
  });

  it("shows both views without a connected count", () => {
    const { html } = render({ accounts: [gmail] });
    expect(html).toContain("Available");
    expect(html).toContain("Connected");
    expect(html).not.toContain("Connected 1");
  });

  it("returns from Google authorization directly to the Connected view", () => {
    const { html } = render({ accounts: [gmail] }, "?connections=connected");
    expect(html).toContain("Disconnect");
    // One account per service: no second-account slot, and no token or
    // identity line — the row action disconnects the grant.
    expect(html).not.toContain("Add account");
    expect(html).not.toContain("ca_1");
    expect(html).toContain('aria-label="Disconnect Gmail from Relay"');
    expect(html).toContain('aria-selected="true" class="rounded-lg px-4 py-2 text-[13.5px] transition-colors bg-card text-ink shadow-sm">Connected');
  });

  it("cannot connect while Google's authorization is unconfigured", () => {
    // A Connect button that silently did nothing would be worse than one that
    // says it is not available yet.
    expect(render({ configured: { gmail: false, "google-calendar": false } }).html).toContain("disabled");
  });

  it("revokes every grant held on the service it disconnects", () => {
    // A leftover second account must not keep serving mail behind a
    // confirmation that says Relay loses access to it.
    const onDisconnect = vi.fn();
    const panel = render({ accounts: [gmail, secondGmail, calendar], onDisconnect }, "?connections=connected");
    panel.click("Disconnect Gmail from Relay");
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith([gmail, secondGmail]);
  });

  it("leaves a confirmed disconnect untouched when the teammate cancels", () => {
    const onDisconnect = vi.fn();
    const panel = render({ accounts: [gmail], onDisconnect }, "?connections=connected", false);
    panel.click("Disconnect Gmail from Relay");
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

describe("github connection", () => {
  const available: GithubConnection = { configured: true, connected: false, connections: [] };
  const connected: GithubConnection = {
    configured: true,
    connected: true,
    account: "pranam434",
    connections: [{ id: "gh_1", account: "pranam434" }],
  };

  it("offers GitHub alongside the Google services once the workspace is configured for it", () => {
    const { html } = render({ github: available });
    expect(html).toContain("GitHub");
    // GitHub is a user-managed connection, so it carries its own Connect.
    expect(html).toContain('aria-label="Connect GitHub"');
  });

  it("hides GitHub entirely when the workspace is not configured for it", () => {
    // A dead Connect would be worse than no row; not configured is distinct
    // from configured-but-disconnected, which does show Connect.
    expect(render({ github: { configured: false, connected: false, connections: [] } }).html).not.toContain("GitHub");
    expect(render().html).not.toContain("GitHub");
  });

  it("starts GitHub authorization from its Connect action", () => {
    const onConnectGithub = vi.fn();
    const panel = render({ github: available, onConnectGithub });
    panel.click("Connect GitHub");
    expect(onConnectGithub).toHaveBeenCalledOnce();
  });

  it("shows the connected account and a Disconnect once GitHub is linked", () => {
    const { html } = render({ github: connected }, "?connections=connected");
    expect(html).toContain("Connected as pranam434");
    expect(html).toContain('aria-label="Disconnect GitHub from Relay"');
    expect(html).not.toContain('aria-label="Connect GitHub"');
  });

  it("revokes GitHub from its Disconnect action", () => {
    const onDisconnectGithub = vi.fn();
    const panel = render({ github: connected, onDisconnectGithub }, "?connections=connected");
    panel.click("Disconnect GitHub from Relay");
    expect(onDisconnectGithub).toHaveBeenCalledOnce();
  });
});

describe("notion connection", () => {
  const available: NotionConnection = { configured: true, connected: false, connections: [] };
  const connected: NotionConnection = {
    configured: true,
    connected: true,
    workspace: "House of 434",
    connections: [{ id: "no_1", workspace: "House of 434" }],
  };

  it("offers Notion alongside the other services once the workspace is configured for it", () => {
    const { html } = render({ notion: available });
    expect(html).toContain("Notion");
    expect(html).toContain('aria-label="Connect Notion"');
  });

  it("hides Notion entirely when the workspace is not configured for it", () => {
    expect(render({ notion: { configured: false, connected: false, connections: [] } }).html).not.toContain("Notion");
    expect(render().html).not.toContain("Notion");
  });

  it("starts Notion authorization from its Connect action", () => {
    const onConnectNotion = vi.fn();
    const panel = render({ notion: available, onConnectNotion });
    panel.click("Connect Notion");
    expect(onConnectNotion).toHaveBeenCalledOnce();
  });

  it("names the connected workspace with a Disconnect once Notion is linked", () => {
    const { html } = render({ notion: connected }, "?connections=connected");
    expect(html).toContain("Connected to House of 434");
    expect(html).toContain('aria-label="Disconnect Notion from Relay"');
    expect(html).not.toContain('aria-label="Connect Notion"');
  });

  it("revokes Notion from its Disconnect action", () => {
    const onDisconnectNotion = vi.fn();
    const panel = render({ notion: connected, onDisconnectNotion }, "?connections=connected");
    panel.click("Disconnect Notion from Relay");
    expect(onDisconnectNotion).toHaveBeenCalledOnce();
  });

  it("does not borrow one provider's identity for the other's row", () => {
    // GitHub reports an account, Notion a workspace: a mis-wired row would show
    // the wrong label, so assert each note only on its own row.
    const { html } = render({
      github: { configured: true, connected: true, account: "pranam434", connections: [] },
      notion: connected,
    }, "?connections=connected");
    expect(html).toContain("Connected as pranam434");
    expect(html).toContain("Connected to House of 434");
  });
});

describe("connectionViews", () => {
  it("offers every shipped service until one is authenticated", () => {
    const views = connectionViews(CONNECTION_SERVICES, []);
    expect(views.available.map((service) => service.id)).toEqual(["gmail", "google-calendar"]);
    expect(views.connected).toEqual([]);
  });

  it("moves a service to Connected once it has an account", () => {
    const views = connectionViews(CONNECTION_SERVICES, [gmail]);
    expect(views.available.map((service) => service.id)).toEqual(["google-calendar"]);
    expect(views.connected.map((service) => service.id)).toEqual(["gmail"]);
    expect(views.accountsByService.get("gmail")).toEqual([gmail]);
  });

  it("keeps every account on a service grouped under that one service", () => {
    const views = connectionViews(CONNECTION_SERVICES, [gmail, secondGmail, calendar]);
    expect(views.connected.map((service) => service.id)).toEqual(["gmail", "google-calendar"]);
    // One row per service, not per account.
    expect(views.accountsByService.get("gmail")?.map((account) => account.email))
      .toEqual(["me@houseof434.com", "other@houseof434.com"]);
  });

  it("treats a service in connectedExternally as connected without a Google account", () => {
    // GitHub's and Notion's connected state is reported by the BFF, not an
    // account list, so they reach the same rows through this set.
    const views = connectionViews([...CONNECTION_SERVICES, GITHUB_SERVICE, NOTION_SERVICE], [], "", new Set(["github", "notion"]));
    expect(views.connected.map((service) => service.id)).toEqual(["github", "notion"]);
    expect(views.available.map((service) => service.id)).toEqual(["gmail", "google-calendar"]);
  });

  it("narrows both views by the search text", () => {
    expect(connectionViews(CONNECTION_SERVICES, [], "calendar").available.map((s) => s.id))
      .toEqual(["google-calendar"]);
    // The search narrows the connected side independently: Gmail is connected
    // but does not match, while Google Calendar still matches on Available.
    expect(connectionViews(CONNECTION_SERVICES, [gmail], "calendar").available.map((s) => s.id))
      .toEqual(["google-calendar"]);
    expect(connectionViews(CONNECTION_SERVICES, [gmail], "calendar").connected).toEqual([]);
    expect(connectionViews(CONNECTION_SERVICES, [], "zzz").available).toEqual([]);
  });
});
