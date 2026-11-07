// A requested connection as one catalog row (Apps -> Available): the icon,
// the name, what the bot will use the connection for, and a single Connect
// button. The card is the whole surface — no status badges or footer prose.
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, PlugZap, Plus, RefreshCw, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { GithubMark, GmailMark, GoogleCalendarMark, NotionMark } from "./ProviderIcons";

async function openConnectionPage(url: string) {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return true;
  }
  const opened = window.open("", "_blank");
  if (!opened) return false;
  opened.opener = null;
  opened.location.replace(url);
  return true;
}

/** The four preconfigured services get their marks; any other Composio
 * toolkit keeps the first-letter tile the card always had. */
function connectorMark(slug: string, label: string): ReactNode {
  switch (slug.trim().toLowerCase()) {
    case "gmail":
      return <GmailMark size={22} />;
    case "googlecalendar":
    case "google_calendar":
    case "google-calendar":
      return <GoogleCalendarMark size={22} />;
    case "github":
      return <GithubMark size={22} />;
    case "notion":
      return <NotionMark size={22} />;
    default:
      return label.slice(0, 1).toUpperCase() || <PlugZap size={19} />;
  }
}

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | { key: LocaleKey } | null>(null);
  const polling = useRef(false);

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return Boolean(result.connected);
  }, [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || connector.dismissed) return;
    polling.current = true;
    let tries = 0;
    const timer = setInterval(() => {
      if (!polling.current) return;
      void checkStatus()
        .then((connected) => {
          tries += 1;
          if (connected || tries >= 75) {
            polling.current = false;
            clearInterval(timer);
          }
        })
        .catch(() => {
          tries += 1;
          if (tries >= 75) clearInterval(timer);
        });
    }, 4_000);
    return () => {
      polling.current = false;
      clearInterval(timer);
    };
  }, [checkStatus, connector.dismissed, connector.status]);

  if (connector.dismissed) return null;

  const connect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const result = await api(`${endpoint}/authorize`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      if (!await openConnectionPage(String(result.url))) {
        setLocalError({ key: "connectors.card.popupBlocked" });
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;

  return (
    <div className="flex w-full justify-start">
      <section
        data-tour="connector"
        aria-label={connector.label}
        className="w-full max-w-[520px] rounded-2xl border border-hairline/50 bg-card px-3.5 py-3 shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary">
            {connectorMark(connector.slug, connector.label)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">{connector.label}</div>
            <div className="mt-0.5 truncate text-[12.5px] leading-relaxed text-ink-secondary">
              {connected
                ? connector.resumed
                  ? t("connectors.card.resumed")
                  : t("connectors.card.paused")
                : authorizing
                  ? t("connectors.card.waiting")
                  : connector.description}
            </div>
          </div>
          {!connected && (
            <button onClick={dismiss} aria-label={t("connectors.card.notNow")} title={t("connectors.card.notNow")} className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink">
              <X size={15} />
            </button>
          )}
          {!connected ? (
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="flex min-w-[88px] shrink-0 items-center justify-center gap-1 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
            >
              {busy || authorizing ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {authorizing
                ? t("connectors.card.openAgain")
                : connector.status === "failed"
                  ? t("connectors.card.tryAgain")
                  : t("connectors.action.connect")}
            </button>
          ) : !connector.resumed ? (
            <button
              onClick={() => void resume()}
              disabled={busy}
              className="flex min-w-[88px] shrink-0 items-center justify-center gap-1 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t("connectors.card.continueTask")}
            </button>
          ) : (
            <span className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-success">
              <Check size={13} /> {t("connectors.card.continuing")}
            </span>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
      </section>
    </div>
  );
}
