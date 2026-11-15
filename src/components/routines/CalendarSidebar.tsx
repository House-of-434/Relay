import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { GripVertical, ListFilter, Search } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "@/components/MenuMotion";
import { MiniMonth } from "./MiniMonth";

export const BOT_CALENDAR_DRAG_TYPE = "application/x-relay-bot";

export interface CalendarSidebarProps {
  bots: Bot[];
  anchor: number;
  onSelectDate: (at: number) => void;
  /** Which bot the schedule is filtered to; "all" shows every bot. */
  botFilter: string;
  onBotFilter: (botId: string) => void;
}

export function CalendarSidebar({ bots, anchor, onSelectDate, botFilter, onBotFilter }: CalendarSidebarProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterMotion = useMenuMotion(filterOpen);
  const filterRef = useRef<HTMLDivElement>(null);
  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return bots;
    return bots.filter((bot) =>
      `${bot.name} ${bot.title} ${bot.description}`.toLocaleLowerCase().includes(normalized),
    );
  }, [bots, query]);

  useEffect(() => {
    if (!filterOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !filterRef.current?.contains(event.target)) setFilterOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [filterOpen]);

  const beginBotDrag = (event: DragEvent<HTMLDivElement>, bot: Bot) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BOT_CALENDAR_DRAG_TYPE, bot.id);
    event.dataTransfer.setData("text/plain", bot.id);
  };

  const filterLabel = botFilter === "all" ? "All bots" : bots.find((bot) => bot.id === botFilter)?.name ?? "All bots";

  return (
    <aside
      aria-label="Schedule sidebar"
      className="flex h-full w-[320px] shrink-0 flex-col overflow-hidden border-r border-hairline/40 bg-panel"
    >
      <MiniMonth anchor={anchor} onSelect={onSelectDate} />

      <div className="mx-4 border-t border-hairline/40" />

      <section aria-labelledby="calendar-bots-heading" className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3">
        <div className="relative mb-2 flex items-center justify-between px-1">
          <div id="calendar-bots-heading" className="text-[11px] font-semibold uppercase tracking-[0.11em] text-ink-secondary">
            Bots
          </div>
          <div ref={filterRef} className="relative flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                setSearchOpen((open) => !open);
                setFilterOpen(false);
              }}
              aria-label="Search bots"
              aria-expanded={searchOpen}
              title="Search bots"
              className="flex size-6 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <Search size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterOpen((open) => !open);
                setSearchOpen(false);
              }}
              aria-label={`Filter schedule: ${filterLabel}`}
              aria-haspopup="listbox"
              aria-expanded={filterOpen}
              title={`Filter schedule: ${filterLabel}`}
              className={cn(
                "flex size-6 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink",
                botFilter !== "all" && "bg-raised text-ink",
              )}
            >
              <ListFilter size={13} aria-hidden="true" />
            </button>

            {filterMotion.shown && (
              <div
                role="listbox"
                aria-label="Filter schedule by bot"
                className={cn("tactile-menu absolute right-0 top-full z-40 mt-1.5 w-[180px] overflow-y-auto p-1", filterMotion.className)}
                {...filterMotion.exitProps}
              >
                {[{ id: "all", name: "All bots" }, ...bots].map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    role="option"
                    aria-selected={botFilter === bot.id}
                    data-chosen={botFilter === bot.id || undefined}
                    onClick={() => {
                      onBotFilter(bot.id);
                      setFilterOpen(false);
                    }}
                    className="tactile-menu-item w-full text-left"
                  >
                    <span className="truncate">{bot.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {searchOpen && (
            <div className="absolute inset-x-1 top-1/2 z-20 flex -translate-y-1/2 items-center gap-2 rounded-full border border-hairline/40 bg-card px-3 py-1">
              <Search size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (query) setQuery("");
                  else setSearchOpen(false);
                }}
                onBlur={() => { if (!query) setSearchOpen(false); }}
                type="search"
                placeholder="Search bots"
                aria-label="Search bots"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </div>
          )}
        </div>

        <div role="list" aria-label="Bots available to schedule" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
          {filteredBots.map((bot) => (
            <div
              key={bot.id}
              draggable
              onDragStart={(event) => beginBotDrag(event, bot)}
              role="listitem"
              className="group flex cursor-grab items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-raised/80 active:cursor-grabbing"
              aria-label={`Drag ${bot.name} onto the schedule`}
              title={`Drag ${bot.name} onto the schedule`}
            >
              <BotAvatar bot={bot} size={27} animated={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-medium text-ink">{bot.name}</div>
                <div className="truncate text-[9.5px] text-ink-tertiary">
                  {bot.title || "BotAgent"}
                </div>
              </div>
              <GripVertical
                size={13}
                className="shrink-0 text-ink-secondary/35 transition-colors group-hover:text-ink-secondary"
                aria-hidden="true"
              />
            </div>
          ))}

          {filteredBots.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] leading-relaxed text-ink-secondary">
              {bots.length === 0 ? "Create a bot to schedule work." : "No bots match your search."}
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}
