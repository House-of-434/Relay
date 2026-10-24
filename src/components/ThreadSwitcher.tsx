// Thread switcher for the chat header: the "Bot / thread" title is the
// trigger, and the dropdown lists every thread the bot owns, newest first.
// Bot-opened subthreads (a Scout deep-research report, a delegated follow-up)
// sit in the same list with an "Opened by <name>" provenance line — they are
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
  deletable?: boolean;
}

function entryTime(entry: ThreadSwitcherEntry): number {
  return entry.updatedAt ?? entry.createdAt;
}

function dayLine(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

  const choose = (threadId: string) => {
    setOpen(false);
    if (threadId !== currentThreadId) onSelect(threadId);
  };

  const requestDelete = (threadId: string) => {
    setOpen(false);
    setPendingDeleteThreadId(threadId);
  };

  return (
    // Hug the content up to the cap so a short name keeps the chevron
    // right after it; longer names truncate at a width that never reflows
    // the header. The trigger fills the container, so its hover always
    // matches the visible width.
    <div className="relative w-fit max-w-[min(11rem,30vw)] shrink-0" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("thread.switcher.label")}
        title={currentTitle}
        className="flex w-full min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <span className="truncate font-medium">{currentTitle}</span>
        <ChevronDown size={15} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {motion.shown && (
        <div
          role="menu"
          aria-label={t("thread.switcher.label")}
          className={cn("absolute left-0 top-full z-40 mt-1 max-h-[min(20rem,50vh)] w-full min-w-[13rem] max-w-[80vw] overflow-y-auto rounded-2xl border border-hairline/50 bg-card px-1.5 py-1.5 shadow-sm shadow-black/30", motion.className)} {...motion.exitProps}
        >
          {visible.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ink-secondary">
              {t("thread.switcher.empty")}
            </div>
          ) : (
            visible.map((entry) => {
              const current = entry.threadId === currentThreadId;
              const meta = entry.openedByName
                ? t("thread.switcher.openedBy", { name: entry.openedByName })
                : dayLine(entryTime(entry));
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
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{entry.title}</span>
                    <span className="max-w-[8rem] shrink-0 truncate text-[11px] text-ink-tertiary">{meta}</span>
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
                      className="pointer-events-none mr-1 flex size-7 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 touch:pointer-events-auto touch:opacity-70"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })
          )}
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
