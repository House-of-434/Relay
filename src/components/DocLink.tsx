// A document link in chat. A button, not an anchor: there is no web URL,
// and it must work from the keyboard. Looks like the links around it.
import type { ReactNode } from "react";
import { useStore } from "@/state/store";
import type { WireDocRef } from "../../shared/wire";

export function DocLink({ target, children }: { target: WireDocRef; children?: ReactNode }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      data-doc-link={`${target.threadId}/${target.messageId}`}
      onClick={() => dispatch({ type: "openDocPane", ref: target })}
      title={target.title ?? target.path}
      className="inline break-words text-start text-accent underline decoration-accent/40 hover:decoration-accent"
    >
      {children}
    </button>
  );
}
