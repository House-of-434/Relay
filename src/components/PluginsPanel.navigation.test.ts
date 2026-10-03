import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { sharedWorkspace: true } }, dispatch: vi.fn() }),
}));

import { CONNECTION_SERVICES, PluginsPanel, connectionViews, type ConnectionAccount, type PluginsPanelProps } from "./PluginsPanel";

const gmail: ConnectionAccount = { service: "gmail", id: "ca_1", email: "me@houseof434.com" };
const calendar: ConnectionAccount = { service: "google-calendar", id: "ca_2", email: "me@houseof434.com" };

const render = (props: Partial<PluginsPanelProps> = {}, search = "") => {
  vi.stubGlobal("window", {
    location: { search, href: `http://localhost:5199/${search}` },
    history: { replaceState: vi.fn() },
    confirm: vi.fn(() => true),
  });
  try {
    return renderToStaticMarkup(createElement(PluginsPanel, {
      accounts: [], configured: {}, loading: false, error: null,
      onConnect: vi.fn(), onDisconnect: vi.fn(), ...props,
    }));
  } finally {
    vi.unstubAllGlobals();
  }
};

describe("Connections marketplace", () => {
  it("offers exactly the two shipped Google services, with no marketplace or MCP", () => {
    const html = render();
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
    const html = render();
    expect(html).toContain('data-tour="apps-panel"');
    expect(html).toContain('data-tour="apps-close"');
  });

  it("shows both views and counts what is connected", () => {
    const html = render({ accounts: [gmail] });
    expect(html).toContain("Available");
    expect(html).toContain("Connected 1");
  });

  it("returns from Google authorization directly to the Connected view", () => {
    const html = render({ accounts: [gmail] }, "?connections=connected");
    expect(html).toContain("me@houseof434.com");
    expect(html).toContain("Disconnect");
    expect(html).toContain('aria-selected="true" class="rounded-lg px-4 py-2 text-[13.5px] transition-colors bg-card text-ink shadow-sm">Connected 1');
  });

  it("cannot connect while Google's authorization is unconfigured", () => {
    // A Connect button that silently did nothing would be worse than one that
    // says it is not available yet.
    expect(render({ configured: { gmail: false, "google-calendar": false } })).toContain("disabled");
  });
});

describe("connectionViews", () => {
  it("offers every shipped service until one is authenticated", () => {
    const views = connectionViews(CONNECTION_SERVICES, []);
    expect(views.available.map((service) => service.id)).toEqual(["gmail", "google-calendar"]);
    expect(views.connected).toEqual([]);
    expect(views.connectedCount).toBe(0);
  });

  it("moves a service to Connected once it has an account", () => {
    const views = connectionViews(CONNECTION_SERVICES, [gmail]);
    expect(views.available.map((service) => service.id)).toEqual(["google-calendar"]);
    expect(views.connected.map((service) => service.id)).toEqual(["gmail"]);
    expect(views.connectedCount).toBe(1);
    expect(views.accountsByService.get("gmail")).toEqual([gmail]);
  });

  it("keeps several accounts on one service together for individual disconnect", () => {
    const second: ConnectionAccount = { service: "gmail", id: "ca_3", email: "other@houseof434.com" };
    const views = connectionViews(CONNECTION_SERVICES, [gmail, second, calendar]);
    expect(views.connected.map((service) => service.id)).toEqual(["gmail", "google-calendar"]);
    // One row per service, not per account.
    expect(views.connectedCount).toBe(2);
    expect(views.accountsByService.get("gmail")?.map((account) => account.email))
      .toEqual(["me@houseof434.com", "other@houseof434.com"]);
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
