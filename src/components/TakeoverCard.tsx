import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Check, ChevronDown, ChevronUp, Maximize2, MonitorPlay, RotateCw, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";

/** Inline live browser. The card is one click target that opens the viewer;
 * opening/closing never changes session ownership. Terminal actions live only
 * inside the viewer, with the optional instruction carried by the same
 * hand-back request. */
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
  const host = takeover.title || t("takeover.title");
  const pending = takeover.status === "pending";
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [nextStep, setNextStep] = useState("");
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!pending) {
      setViewerPath(null);
      setNoteOpen(false);
    }
  }, [pending]);

  useEffect(() => {
    if (viewerPath) closeRef.current?.focus();
  }, [viewerPath]);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  /** Escape closes the instruction row first, then the viewer. It never
   * settles the session. */
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (noteOpen) setNoteOpen(false);
    else setViewerPath(null);
  };

  useEffect(() => {
    if (!viewerPath) return;
    const handler = (event: KeyboardEvent) => escape(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [viewerPath, noteOpen]);

  const openViewer = async () => {
    if (loading || acting) return;
    setLoading(true);
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
      setLoading(false);
    }
  };

  const settle = async (action: "done" | "dismiss") => {
    if (acting) return;
    setActing(true);
    setError(null);
    try {
      await api(`${endpoint}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          threadId,
          ...(action === "done" && nextStep.trim() ? { note: nextStep.trim() } : {}),
        }),
      });
      setViewerPath(null);
      setNoteOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setActing(false);
    }
  };

  const fullScreen = () => {
    const element = document.querySelector<HTMLElement>("[data-takeover-viewer]");
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.();
  };

  /** Focus the iframe's window so Escape still reaches the parent first. */
  const bindFrame = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const win = event.currentTarget.contentWindow;
    win?.addEventListener("keydown", escape, true);
  };

  if (!pending) {
    const note = takeover.status === "done"
      ? t("takeover.doneNote")
      : takeover.status === "expired"
        ? t("takeover.expiredNote")
        : t("takeover.dismissedNote");
    const retryable = takeover.resumed === false && Boolean(takeover.error);
    return (
      <div className="flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="takeover-card">
        {takeover.status === "done"
          ? <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
          : <X size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />}
        <span>{note}</span>
        {takeover.resumed ? <span className="text-[11px] text-ink-secondary">{t("takeover.resumed")}</span> : null}
        {retryable ? (
          <button
            type="button"
            onClick={() => settle(takeover.status === "done" ? "done" : "dismiss")}
            disabled={acting}
            className="inline-flex items-center gap-1 rounded-lg border border-hairline/50 px-2 py-1 text-[11px] disabled:opacity-60"
          >
            <RotateCw size={11} aria-hidden="true" />
            {t("takeover.retry")}
          </button>
        ) : null}
        {error || (!retryable ? null : takeover.error) ? (
          <span className="text-danger">{error ?? takeover.error}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-fit max-w-full" data-testid="takeover-card">
      <button
        type="button"
        onClick={openViewer}
        disabled={loading || acting}
        aria-label={`${t("takeover.openHint")}: ${host}`}
        className="group block w-[min(26rem,100%)] overflow-hidden rounded-xl border border-hairline/50 bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-70"
      >
        <div className="flex items-center gap-1.5 border-b border-hairline/40 bg-inset px-3 py-1.5">
          <span className="h-2 w-2 rounded-full bg-danger/70" aria-hidden="true" />
          <span className="h-2 w-2 rounded-full bg-amber-400/80" aria-hidden="true" />
          <span className="h-2 w-2 rounded-full bg-success/70" aria-hidden="true" />
          <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary">{host}</span>
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">{t("takeover.pending")}</span>
        </div>
        <div className="relative flex h-32 items-center justify-center bg-gradient-to-br from-raised via-panel to-inset">
          <span className="flex flex-col items-center gap-1.5 text-ink-secondary">
            <MonitorPlay size={22} className="opacity-70" aria-hidden="true" />
            <span className="text-[12px] font-medium">{loading ? t("takeover.working") : t("takeover.openHint")}</span>
          </span>
        </div>
        <div className="border-t border-hairline/40 px-3 py-2">
          <p className="line-clamp-1 text-[12px] text-ink-secondary">
            {takeover.description || t("takeover.hint")}
          </p>
        </div>
      </button>
      {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}

      {viewerPath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label={t("takeover.iframeTitle")}>
          <div
            data-takeover-viewer
            className="flex h-[94vh] w-[96vw] max-w-[1600px] flex-col overflow-hidden rounded-2xl bg-black shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-white">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              <span className="text-[12px] font-medium">{t("takeover.live")}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-white/60">· {host}</span>
              <button type="button" onClick={fullScreen} className="rounded p-1.5 hover:bg-white/10" aria-label={t("takeover.fullscreen")}>
                <Maximize2 size={15} />
              </button>
              <button ref={closeRef} type="button" onClick={() => setViewerPath(null)} className="rounded p-1.5 hover:bg-white/10" aria-label={t("takeover.close")}>
                <X size={15} />
              </button>
            </div>
            <iframe
              title={t("takeover.iframeTitle")}
              src={`${viewerPath}${viewerPath.includes("?") ? "&" : "?"}embed=1`}
              onLoad={bindFrame}
              className="min-h-0 flex-1 border-0 bg-black"
              allow="clipboard-read; clipboard-write"
            />
            {noteOpen ? (
              <div className="border-t border-white/10 bg-black/60 px-3 py-2">
                <label className="block text-[11px] text-white/60">
                  {t("takeover.note")}
                  <input
                    ref={noteRef}
                    type="text"
                    value={nextStep}
                    maxLength={500}
                    onChange={(event) => setNextStep(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void settle("done");
                    }}
                    placeholder={t("takeover.notePlaceholder")}
                    className="mt-1 w-full rounded-lg border border-white/20 bg-white/5 px-2 py-1.5 text-[12px] text-white placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </label>
                <p className="mt-1 text-[10px] text-white/45">{t("takeover.noteHint")}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2">
              <span className="hidden min-w-0 flex-1 truncate text-[11px] text-white/50 sm:block">{t("takeover.hint")}</span>
              <button type="button" onClick={() => settle("dismiss")} disabled={acting} className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] text-white disabled:opacity-60">
                {t("takeover.dismiss")}
              </button>
              <div className="flex overflow-hidden rounded-lg">
                <button
                  type="button"
                  onClick={() => settle("done")}
                  disabled={acting}
                  className={cn("bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60", acting && "cursor-wait")}
                >
                  {t("takeover.handBack")}
                </button>
                <button
                  type="button"
                  onClick={() => setNoteOpen((open) => !open)}
                  aria-expanded={noteOpen}
                  aria-label={noteOpen ? t("takeover.noteHide") : t("takeover.noteAdd")}
                  className="border-l border-white/20 bg-accent px-2 py-1.5 text-white hover:bg-accent/90"
                >
                  {noteOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
            </div>
            {error ? <p className="border-t border-white/10 px-3 py-2 text-[11px] text-danger">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
