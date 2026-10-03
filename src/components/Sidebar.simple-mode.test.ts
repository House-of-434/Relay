import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { BotListItem, GroupListItem } from "./Sidebar";

const bot: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "Research", description: "Research companies",
  notifications: true, color: "blue", unread: true, busy: false,
  modelSelection: { instanceId: "fake", model: "test" },
  messages: [{ id: "reply", role: "bot", kind: "text", text: "A sourced update", at: 1 }],
  tasks: [
    { threadId: "scout-main", title: "Current conversation", createdAt: 1 },
    { threadId: "older", title: "Earlier thread", createdAt: 0 },
  ],
};

beforeEach(() => {
  fixture.state = { bots: [bot], groups: [], selectedId: bot.id, activeView: "chat", pendingQueued: {} };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("Relay's simplified sidebar", () => {
  it("shows one agent row and no thread-history controls", () => {
    const markup = renderToStaticMarkup(createElement(BotListItem, { bot, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Scout");
    expect(markup).toContain("A sourced update");
    expect(markup).not.toContain("Earlier thread");
    expect(markup).not.toContain("All threads");
    expect(markup).not.toContain("data-sidebar-thread-row");
    expect(markup).not.toContain("New thread");
  });

  it("keeps a room's single conversation without task-history navigation", () => {
    const group: Group = {
      id: "room", threadId: "room-main", name: "Relay Intel — Shared", memberIds: [bot.id],
      defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false, createdAt: 1,
      messages: [{ id: "room-reply", role: "bot", kind: "text", text: "Daily brief", at: 2 }],
      tasks: [
        { threadId: "room-main", title: "Current room", createdAt: 1 },
        { threadId: "room-old", title: "Older room task", createdAt: 0 },
      ],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Relay Intel — Shared");
    expect(markup).not.toContain("Older room task");
    expect(markup).not.toContain("All threads");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("data-sidebar-thread-row");
  });
});
