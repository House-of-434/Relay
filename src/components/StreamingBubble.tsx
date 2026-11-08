import { ChatMarkdown } from "./ChatMarkdown";
import { t } from "@/lib/i18n";

/** The in-flight assistant turn, rendered below the settled transcript while
 * tokens arrive. Reasoning shows only until the answer starts: keeping a
 * collapsed reasoning header here would disappear when the turn settles and
 * shift the answer by its height. */
export function StreamingBubble({
  threadId,
  text,
  reasoning,
}: {
  threadId: string;
  text?: string;
  reasoning?: string;
}) {
  const answer = text?.trim() ? text : "";
  const thinking = reasoning?.trim() ? reasoning : "";
  if (!answer && !thinking) return null;
  return (
    <div className="flex w-full justify-start" data-testid="streaming-bubble">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        {thinking && !answer ? (
          <details open className="text-[13px] text-ink-secondary">
            <summary className="cursor-pointer select-none">{t("chat.reasoning")}</summary>
            <div className="mt-1 whitespace-pre-wrap break-words">{thinking}</div>
          </details>
        ) : null}
        {answer ? (
          <ChatMarkdown text={answer} streaming message={{ threadId, messageId: "streaming" }} />
        ) : null}
      </div>
    </div>
  );
}
