import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmDialog } from "./ConfirmDialog";
import { ThreadSwitcher, type ThreadSwitcherEntry } from "./ThreadSwitcher";

const fixture = vi.hoisted(() => ({ confirm: null as ComponentProps<typeof ConfirmDialog> | null }));

vi.mock("./MenuMotion", () => ({
  useMenuMotion: () => ({ shown: true, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./ConfirmDialog", () => ({
  ConfirmDialog: (props: ComponentProps<typeof ConfirmDialog>) => {
    fixture.confirm = props;
    return createElement("span", { "data-test-confirm": true });
  },
}));

const entries: ThreadSwitcherEntry[] = [
  { threadId: "alpha", title: "Alpha", createdAt: 2 },
  { threadId: "locked", title: "Locked", createdAt: 1, deletable: false },
  { threadId: "hidden", title: "Hidden", createdAt: 3, hidden: true },
];

beforeEach(() => {
  fixture.confirm = null;
});

describe("ThreadSwitcher", () => {
  it("offers deletion only for visible threads that can be removed", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "alpha",
      currentTitle: "Alpha",
      entries,
      onSelect: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Delete thread: Alpha"');
    expect(markup).not.toContain('aria-label="Delete thread: Locked"');
    expect(markup).not.toContain('aria-label="Delete thread: Hidden"');
    expect(markup).toContain('title="Delete this thread and its conversation"');
    expect(markup).toContain('aria-current="true"');
  });

  it("does not render deletion when the owner has no delete path", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "alpha",
      currentTitle: "Alpha",
      entries,
      onSelect: vi.fn(),
    }));

    expect(markup).not.toContain("Delete thread:");
  });

  it("wires the confirmation dialog copy and dangerous tone", () => {
    renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "alpha",
      currentTitle: "Alpha",
      entries,
      onSelect: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(fixture.confirm).toMatchObject({
      open: false,
      title: "Delete thread?",
      body: "This permanently deletes every transcript and session in this thread. This cannot be undone.",
      confirmLabel: "Delete thread",
      tone: "danger",
    });
  });
});
