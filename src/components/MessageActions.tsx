import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Class shared by every control that lives inside the tray: the tray decides
 * when the row is visible, so the buttons themselves never fade. */
export const messageActionClass =
  "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

/** The row of message controls beside a bubble. One quiet row that fades in
 * on bubble hover or keyboard focus and stays visible on touch, where there
 * is no hover — no handle, no second hover to reach the options. Children
 * render in reading order; the tray mirrors them on the user side so the
 * first control stays nearest the bubble on both sides. */
export function MessageActions({
  side,
  className,
  children,
}: {
  side: "user" | "bot";
  className?: string;
  children: ReactNode;
}) {
  const mirrored = side === "user";
  return (
    <div
      className={cn(
        "pointer-events-none flex items-center gap-0.5 self-end pb-0.5 opacity-0 transition-opacity",
        "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 touch:pointer-events-auto touch:opacity-100",
        mirrored && "flex-row-reverse",
        className,
      )}
      data-testid="message-actions"
    >
      {children}
    </div>
  );
}
