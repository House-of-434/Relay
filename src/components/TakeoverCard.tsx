import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Check, Maximize2, Monitor, RotateCw, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";

/** The pending card's one-shot preview. A missing or failed image falls back
 * to the neutral desktop tile; it never blocks the card or the viewer. */
function TakeoverPreview({
  botId,
  threadId,
  messageId,
  hasScreenshot,
  host,
}: {
  botId: string;
  threadId: string;
  messageId: string;
  hasScreenshot: boolean;
  host: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!hasScreenshot) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fetch(
      `/api/bots/${encodeURIComponent(botId)}/takeover-cards/${encodeURIComponent(messageId)}/screenshot?threadId=${encodeURIComponent(threadId)}`,
      { signal: controller.signal },
    )
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { /* placeholder stays */ });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, threadId, messageId, hasScreenshot]);

  if (src) {
    return (
      <img
        src={src}
        alt={host}
        className="h-40 w-full object-cover object-top"
      />
    );
  }
  return (
    <div className="flex h-40 items-center justify-center bg-gradient-to-br from-raised via-panel to-inset">
      <Monitor size={22} className="text-ink-secondary opacity-70" aria-hidden="true" />
    </div>
  );
}

/** Inline live browser. The card is one click target that opens the viewer;
 * opening/closing never changes session ownership. Terminal actions live only
 * inside the viewer, as a floating check (hand back) and cross (dismiss). A
 * person's chat message is the handover with its text as the instruction. */
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
  const [localOpen, setLocalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!pending) {
      setViewerPath(null);
      setLocalOpen(false);
    }
  }, [pending]);

  useEffect(() => {
    if (viewerPath) closeRef.current?.focus();
  }, [viewerPath]);

  /** Escape closes the viewer. It never settles the session. */
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setViewerPath(null);
  };

  useEffect(() => {
    if (!viewerPath) return;
    const handler = (event: KeyboardEvent) => escape(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [viewerPath]);

  const openViewer = async () => {
    if (loading || acting) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ path: string; local?: boolean }>(`${endpoint}/viewer`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      if (result.local) {
        setLocalOpen(true);
        setViewerPath(null);
      } else {
        setViewerPath(result.path);
      }
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
        body: JSON.stringify({ threadId }),
      });
      setViewerPath(null);
      setLocalOpen(false);
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
        className="group block w-[min(32rem,100%)] overflow-hidden rounded-xl border border-hairline/50 bg-panel text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-70"
      >
        <TakeoverPreview
          botId={botId}
          threadId={threadId}
          messageId={message.id}
          hasScreenshot={takeover.hasScreenshot === true}
          host={host}
        />
      </button>
      {localOpen ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-panel px-3 py-2">
          <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-ink-secondary">{t("takeover.hint")}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => settle("dismiss")}
              disabled={acting}
              className="flex size-8 items-center justify-center rounded-full border border-hairline/50 text-ink-secondary transition hover:bg-raised-hover disabled:opacity-60"
              title={t("takeover.dismiss")}
              aria-label={t("takeover.dismiss")}
            >
              <X size={16} />
            </button>
            <button
              type="button"
              onClick={() => settle("done")}
              disabled={acting}
              className="flex size-8 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent/90 disabled:opacity-60"
              title={t("takeover.handBack")}
              aria-label={t("takeover.handBack")}
            >
              <Check size={16} />
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}

      {viewerPath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label={t("takeover.iframeTitle")}>
          <div
            data-takeover-viewer
            className="relative flex h-[94vh] w-[96vw] max-w-[1600px] flex-col overflow-hidden rounded-2xl bg-black shadow-2xl"
          >
            <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
              <button
                type="button"
                onClick={fullScreen}
                className="flex size-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur transition hover:bg-black/80"
                title={t("takeover.fullscreen")}
                aria-label={t("takeover.fullscreen")}
              >
                <Maximize2 size={17} />
              </button>
              <button
                type="button"
                onClick={() => settle("done")}
                disabled={acting}
                className="flex size-10 items-center justify-center rounded-full bg-accent text-white shadow-lg transition hover:bg-accent/90 disabled:opacity-60"
                title={t("takeover.handBack")}
                aria-label={t("takeover.handBack")}
              >
                <Check size={18} />
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => settle("dismiss")}
                disabled={acting}
                className="flex size-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur transition hover:bg-black/80 disabled:opacity-60"
                title={t("takeover.close")}
                aria-label={t("takeover.close")}
              >
                <X size={18} />
              </button>
            </div>
            <iframe
              title={t("takeover.iframeTitle")}
              src={`${viewerPath}${viewerPath.includes("?") ? "&" : "?"}embed=1`}
              onLoad={bindFrame}
              className="min-h-0 flex-1 border-0 bg-black"
              allow="clipboard-read; clipboard-write"
            />
            {error ? <p className="border-t border-white/10 px-3 py-2 text-[11px] text-danger">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
