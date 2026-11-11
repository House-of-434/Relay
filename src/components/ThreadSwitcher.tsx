// Thread switcher for the chat header: the "Bot / thread" title is the
// trigger, and the dropdown lists every thread the bot owns, newest first.
// Bot-opened subthreads (a Scout deep-research report, a delegated follow-up)
// sit in the same list, tagged with the bot that opened them — they are
// ordinary threads the person can continue in, not a separate kind.
// Switching only moves the VIEW (switchTask); a turn running elsewhere keeps
// running. The entries arrive pre-sorted from the snapshot's tasks array, so
// the panel is a plain scrollable list, not a virtualized one.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { useMenuMotion } from "./MenuMotion";

export interface ThreadSwitcherEntry {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  unread?: boolean;
  /** Name of the bot that opened this thread, when it wasn't the person. */
  openedByName?: string;
  /** Routine-internal, closed, or archived threads never list. */
  hidden?: boolean;
  /** False hides the row's delete action. Defaults to true; callers own the
      policy (GroupView clears it when one thread remains, which the server keeps). */
  deletable?: boolean;
}

function entryTime(entry: ThreadSwitcherEntry): number {
  return entry.updatedAt ?? entry.createdAt;
}

/** A bot-opened conversation is titled `@<opener>` (or `@<opener> · <label>`
 * for parallel work) on the server, which reads as a bare mention rather than
 * a thread name. The header wants the whole attribution ("<opener>'s
 * Conversation"); a dropdown row names the thread plainly ("Conversation") and
 * leans on the opener pill beside it. A work thread keeps its label in both.
 * Any name a person chose is returned unchanged. */
export function threadTitles(title: string, openedByName?: string): { header: string; row: string } {
  const opener = openedByName?.trim();
  if (!opener) return { header: title, row: title };
  if (title.trim() === `@${opener}`) {
    return {
      header: t("thread.switcher.pairTitle", { name: opener }),
      row: t("thread.switcher.pairName"),
    };
  }
  const workPrefix = `@${opener} · `;
  if (title.startsWith(workPrefix)) {
    const label = title.slice(workPrefix.length) || title;
    return { header: label, row: label };
  }
  return { header: title, row: title };
}

export function ThreadSwitcher({
  currentThreadId,
  currentTitle,
  entries,
  onSelect,
  onDelete,
}: {
  currentThreadId: string;
  currentTitle: string;
  entries: readonly ThreadSwitcherEntry[];
  onSelect: (threadId: string) => void;
  onDelete?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
  // The lane shows only mid-scroll: a scroll event raises it, 800ms of
  // stillness lowers it again. Hover alone never reveals it.
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
  }, []);
  const motion = useMenuMotion(open);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open ]);

  const visible = entries
    .filter((entry: ThreadSwitcherEntry) => !entry.hidden)
    .sort((a: ThreadSwitcherEntry, b: ThreadSwitcherEntry) => entryTime(b) - entryTime(a));
  const currentEntry = entries.find((entry) => entry.threadId === currentThreadId);
  const headerTitle = threadTitles(currentTitle, currentEntry?.openedByName).header;

  const choose = (threadId: string) => {
    setOpen(false);
    if (threadId !== currentThreadId) onSelect(threadId);
  };

  const requestDelete = (threadId: string) => {
    setOpen(false);
    setPendingDeleteThreadId(threadId);
  };

  const onMenuScroll = () => {
    setScrolling(true);
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      scrollTimer.current = null;
      setScrolling(false);
    }, 800);
  };

  return (
    // Fixed width, matching the dropdown below: the thread name occupies the
    // same 238px in the header as the selector opens to, so switching threads
    // never shifts the header layout, and long names truncate at that width.
    // The trigger itself hugs the title plus the chevron, so the hover
    // highlight covers only the visible name, not the whole 238px.
    <div className="relative -ml-2 w-[238px] max-w-full shrink-0" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("thread.switcher.label")}
        title={headerTitle}
        className="flex w-fit max-w-full items-center gap-1 rounded-md py-0.5 pl-2 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <span className="min-w-0 truncate font-medium">{headerTitle}</span>
        <ChevronDown size={15} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {motion.shown && (
        // The card keeps its padding; the list scrolls inside it and is pulled
        // into the card's right padding (-mr-1.5), so the scroll lane lands
        // on that padding instead of adding width beside it.
        <div
          className={cn("absolute left-0 top-full z-40 mt-1 flex max-h-[min(20rem,50vh)] w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card pt-1.5 pb-1.5 pr-1.5 shadow-sm shadow-black/30", motion.className)} {...motion.exitProps}
        >
        <div
          role="menu"
          aria-label={t("thread.switcher.label")}
          onScroll={onMenuScroll}
          className={cn("scroll-thin-autohide -mr-1.5 min-h-0 flex-1 overflow-y-auto pl-1.5 pr-0", scrolling && "is-scrolling")}
        >
          {visible.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ink-secondary">
              {t("thread.switcher.empty")}
            </div>
          ) : (
            visible.map((entry) => {
              const current = entry.threadId === currentThreadId;
              const opener = entry.openedByName?.trim() ? entry.openedByName.trim() : null;
              return (
                <div
                  key={entry.threadId}
                  className={cn(
                    "group/thread flex w-full items-center rounded-lg",
                    // Hover never touches the selected row: dimming the
                    // highlight under the cursor reads as losing selection.
                    current ? "bg-selected" : "hover:bg-raised/70",
                  )}
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={current || undefined}
                    onClick={() => choose(entry.threadId)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {opener && (
                        <span
                          title={opener}
                          className="max-w-[8rem] shrink-0 truncate rounded-full border border-hairline/30 bg-raised px-1.5 py-px text-[10.5px] leading-4 text-ink-secondary"
                        >
                          <span aria-hidden="true">{opener}</span>
                          <span className="sr-only">{t("thread.switcher.openedBy", { name: opener })}</span>
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                        {threadTitles(entry.title, entry.openedByName).row}
                      </span>
                    </span>
                    {entry.unread && !current && (
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
                    )}
                  </button>
                  {onDelete && entry.deletable !== false && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`${t("task.deleteAria")}: ${entry.title}`}
                      title={t("task.deleteTitle")}
                      onClick={() => requestDelete(entry.threadId)}
                      className="pointer-events-none mr-1 flex size-7 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 touch:pointer-events-auto touch:opacity-70"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteThreadId !== null}
        title={t("task.deleteConfirm")}
        body={t("thread.deleteBody")}
        confirmLabel={t("thread.delete")}
        tone="danger"
        returnFocusRef={triggerRef}
        onCancel={() => setPendingDeleteThreadId(null)}
        onConfirm={() => {
          const threadId = pendingDeleteThreadId;
          setPendingDeleteThreadId(null);
          if (threadId && onDelete) onDelete(threadId);
        }}
      />
    </div>
  );
}
