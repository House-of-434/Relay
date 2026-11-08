import { useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, Maximize2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";

/** Inline sign-in intervention. The panel is a live VNC view of the bot's
 * browser; the viewer token is minted on open and never stored in the card. */
export function TakeoverCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const takeover = message.takeover!;
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/takeover-cards/${encodeURIComponent(message.id)}`;
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState("");
  const frameRef = useRef<HTMLDivElement | null>(null);
  const pending = takeover.status === "pending";
  const declined = takeover.status === "dismissed" || takeover.status === "expired";

  useEffect(() => {
    if (!pending) setViewerPath(null);
  }, [pending]);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ path: string }>(`${endpoint}/viewer`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      setViewerPath(result.path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const settle = async (action: "done" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/${action}`, {
        method: "POST",
        body: JSON.stringify({ threadId, ...(action === "done" && nextStep.trim() ? { note: nextStep.trim() } : {}) }),
      });
      setViewerPath(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const retryResume = async () => {
    await settle(takeover.status === "done" ? "done" : "dismiss");
  };

  const fullScreen = () => {
    const element = frameRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.();
  };

  const note = takeover.status === "done"
    ? t("takeover.doneNote")
    : takeover.status === "expired"
      ? t("takeover.expiredNote")
      : t("takeover.dismissedNote");

  return (
    <div className="w-fit max-w-full rounded-xl border border-hairline/40 bg-panel p-3 text-[13px] text-ink-secondary" data-testid="takeover-card">
      <div className="flex items-center gap-2 text-ink">
        <LogIn size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="font-medium">{takeover.title || t("takeover.title")}</span>
      </div>
      <p className="mt-1 max-w-[34rem]">{pending ? `${takeover.description} ${t("takeover.pending")}` : note}</p>

      {pending ? (
        <label className="mt-2 block text-[12px]">
          <span className="text-ink-secondary">{t("takeover.note")}</span>
          <input
            type="text"
            value={nextStep}
            onChange={(event) => setNextStep(event.target.value)}
            maxLength={500}
            placeholder={t("takeover.notePlaceholder")}
            className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-2 py-1.5 text-[12px] text-ink"
          />
        </label>
      ) : null}

      {pending ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={open}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
          >
            <ExternalLink size={13} aria-hidden="true" />
            {busy ? t("takeover.working") : t("takeover.open")}
          </button>
          <button type="button" onClick={() => settle("done")} disabled={busy} className="rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px] disabled:opacity-60">
            {t("takeover.done")}
          </button>
          <button type="button" onClick={() => settle("dismiss")} disabled={busy} className="rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px] disabled:opacity-60">
            {t("takeover.dismiss")}
          </button>
        </div>
      ) : null}

      {!pending && declined && takeover.resumed === false ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-danger">{t("takeover.failedResume")}</span>
          <button type="button" onClick={retryResume} disabled={busy} className="rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px]">
            {t("takeover.retry")}
          </button>
        </div>
      ) : null}

      {!pending && takeover.resumed ? (
        <p className="mt-2 text-[11px]">{t("takeover.resumed")}</p>
      ) : null}

      {error ? <p className="mt-2 text-danger">{error}</p> : null}

      {viewerPath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true" aria-label={t("takeover.iframeTitle")}>
          <div ref={frameRef} className="flex h-[min(88vh,900px)] w-[min(96vw,1400px)] flex-col overflow-hidden rounded-xl bg-black">
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-white">
              <span className="min-w-0 flex-1 truncate font-medium">{takeover.title || t("takeover.title")}</span>
              <button type="button" onClick={fullScreen} className="rounded p-1.5 hover:bg-white/10" aria-label={t("takeover.fullscreen")}>
                <Maximize2 size={15} />
              </button>
              <button type="button" onClick={() => setViewerPath(null)} className="rounded p-1.5 hover:bg-white/10" aria-label={t("takeover.close")}>
                <X size={15} />
              </button>
            </div>
            <iframe
              title={t("takeover.iframeTitle")}
              src={`${viewerPath}${viewerPath.includes("?") ? "&" : "?"}embed=1`}
              className="min-h-0 flex-1 border-0 bg-black"
              allow="clipboard-read; clipboard-write"
            />
            <div className="flex items-center justify-end gap-2 border-t border-white/10 px-3 py-2">
              <button type="button" onClick={() => settle("dismiss")} disabled={busy} className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] text-white disabled:opacity-60">
                {t("takeover.dismiss")}
              </button>
              <button type="button" onClick={() => settle("done")} disabled={busy} className={cn("rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white", busy && "opacity-60")}>
                {t("takeover.done")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
