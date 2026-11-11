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
  it("has a fixed width shared by the thread name and the dropdown", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "alpha",
      currentTitle: "A very long thread title that must not resize the dropdown",
      entries,
      onSelect: vi.fn(),
    }));

    expect(markup).toContain("w-[238px]");
    expect(markup).not.toContain("min-w-[13rem]");
    expect(markup).not.toContain("w-fit min-w-0 max-w-full");
  });

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

  it("renders a bot-opened pair conversation as a readable thread name with an opener pill", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "curator",
      currentTitle: "@curator",
      entries: [
        { threadId: "curator", title: "@curator", createdAt: 2, openedByName: "curator" },
        { threadId: "digest", title: "Weekly digest", createdAt: 1 },
      ],
      onSelect: vi.fn(),
    }));

    // The header reads "curator's Conversation" with no pill; the dropdown row
    // names the thread plainly ("Conversation") with the opener pill on the
    // left.
    expect(markup).toContain("curator&#x27;s Conversation");
    expect(markup).toContain("rounded-full border border-hairline/30");
    expect(markup).toContain(">curator<");
    expect(markup).toContain(">Conversation<");
    // The pill precedes the row name.
    expect(markup.indexOf(">curator<")).toBeLessThan(markup.indexOf(">Conversation<"));
    expect(markup).toContain("Weekly digest");
  });

  it("keeps a parallel work thread's label and a person's own title", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "work",
      currentTitle: "@curator · parallel work",
      entries: [
        { threadId: "work", title: "@curator · parallel work", createdAt: 3, openedByName: "curator" },
        { threadId: "mine", title: "My research", createdAt: 1 },
      ],
      onSelect: vi.fn(),
    }));

    expect(markup).toContain("parallel work");
    expect(markup).not.toContain("@curator ·");
    expect(markup).toContain("My research");
  });

  it("overlaps the scroll lane with the card's right padding", () => {
    const markup = renderToStaticMarkup(createElement(ThreadSwitcher, {
      currentThreadId: "alpha",
      currentTitle: "Alpha",
      entries,
      onSelect: vi.fn(),
    }));

    // The lane lands on the card's right padding instead of beside it: the
    // card keeps its padding, and the list is pulled into it.
    expect(markup).toContain("pr-1.5");
    expect(markup).toContain("-mr-1.5");
    expect(markup).toContain("pr-0");
    expect(markup).toContain("scroll-thin-autohide");
    // No extra bottom padding: the list ends where the card's padding ends.
    expect(markup).not.toContain("pb-3");
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
      confirmLabel: "Delete",
      tone: "danger",
    });
  });
});
