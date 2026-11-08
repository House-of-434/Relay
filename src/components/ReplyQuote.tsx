import { X } from "lucide-react";

import { ReplyIcon } from "./ReplyIcon";

import { peerLine } from "@/lib/peer-message";
import { replySnippet } from "@/lib/replies";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function ReplyQuote({
  message,
  onJump,
  onClear,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
}) {
  const snippet = replySnippet(peerLine(message)?.body ?? message.text ?? "");
  // Composer selection: minimal attachment chip — selected text only, with the
  // REPLY tag row at the bottom. Message quotes (onJump, no onClear) keep the bar.
  if (onClear) {
    return (
      <div className="group relative flex h-[112px] w-[172px] flex-col rounded-xl border border-hairline/40 bg-raised px-2.5 py-2.5 pb-0.5">
        <span dir="auto" className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words text-[10.5px] leading-[1.45] text-ink">{snippet}</span>
        <div className="mt-auto flex items-center gap-0.5 pt-1">
          <ReplyIcon size={11} className="text-ink-tertiary" />
          <span className="rounded px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
            REPLY
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label={t("chat.reply.cancel")}
          className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
        >
          <X size={11} />
        </button>
      </div>
    );
  }
  const body = (
    <>
      <ReplyIcon size={12} className="shrink-0 text-ink-secondary" />
      <span className="text-[11.5px] font-medium text-ink-secondary">{t("chat.reply")}</span>
    </>
  );
  return (
    <div className="mb-0.5 flex w-fit items-center">
      {onJump ? (
        <button type="button" onClick={onJump} className="flex min-w-0 items-center gap-1.5" title={snippet ? `${t("chat.reply.jump")}: ${snippet}` : t("chat.reply.jump")}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">{body}</div>
      )}
    </div>
  );
}
