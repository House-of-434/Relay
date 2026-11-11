import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Check, Monitor, X } from "lucide-react";

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
        className="aspect-video w-full object-cover object-top"
      />
    );
  }
  return (
    <div className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-raised via-panel to-inset">
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
  const [viewerReady, setViewerReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!pending) {
      setViewerPath(null);
      setLocalOpen(false);
      setViewerReady(false);
    }
  }, [pending]);

  useEffect(() => {
    if (viewerPath) closeRef.current?.focus();
  }, [viewerPath]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === "relay-takeover-viewer-ready" || type === "relay-takeover-viewer-error") {
        setViewerReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!viewerPath || viewerReady) return;
    const timer = setTimeout(() => setViewerReady(true), 15_000);
    return () => clearTimeout(timer);
  }, [viewerPath, viewerReady]);

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
    setViewerReady(false);
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
      setViewerReady(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setActing(false);
    }
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
    return (
      <div className="flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="takeover-card">
        {takeover.status === "done"
          ? <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
          : <X size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />}
        <span>{note}</span>
        {error || takeover.error ? (
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
        <div className="fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label={t("takeover.iframeTitle")}>
          <div className="relative flex h-full w-full flex-col overflow-hidden bg-black">
            <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
              <button
                ref={closeRef}
                type="button"
                onClick={() => settle("dismiss")}
                disabled={acting}
                className="flex size-8 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur transition hover:bg-black/80 disabled:opacity-60"
                title={t("takeover.close")}
                aria-label={t("takeover.close")}
              >
                <X size={15} />
              </button>
              <button
                type="button"
                onClick={() => settle("done")}
                disabled={acting}
                className="group flex h-8 items-center justify-center rounded-full bg-accent px-2 text-white shadow-lg transition-all hover:gap-1.5 hover:bg-accent/90 focus-visible:gap-1.5 disabled:opacity-60"
                title={t("takeover.handBack")}
                aria-label={t("takeover.handBack")}
              >
                <span className="max-w-0 overflow-hidden whitespace-nowrap text-[11px] font-medium opacity-0 transition-all duration-200 group-hover:max-w-24 group-hover:opacity-100 group-focus-visible:max-w-24 group-focus-visible:opacity-100">
                  {t("takeover.handBackShort")}
                </span>
                <Check size={15} className="shrink-0" />
              </button>
            </div>
            <iframe
              ref={iframeRef}
              title={t("takeover.iframeTitle")}
              src={`${viewerPath}${viewerPath.includes("?") ? "&" : "?"}embed=1`}
              onLoad={bindFrame}
              className="min-h-0 flex-1 border-0 bg-black"
              allow="clipboard-read; clipboard-write"
            />
            {!viewerReady ? (
              <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 bg-black text-white">
                <span className="size-7 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden="true" />
                <span className="text-[12px] text-white/70">{t("takeover.working")}</span>
              </div>
            ) : null}
            {error ? <p className="border-t border-white/10 px-3 py-2 text-[11px] text-danger">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
