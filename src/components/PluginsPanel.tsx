// Relay's connections marketplace.
//
// The catalog is Relay's, not the user's: Gmail and Google Calendar ship
// preconfigured, and a teammate's job is to authenticate their own Google
// account against one of them. There is no connector marketplace to browse and
// no teammate-managed MCP server list — Relay mounts its own agent routes from
// the workspace, so reaching data beyond these services is a request to the
// team who runs the workspace.
//
// Two views, the pair this panel has always had: what you can connect
// (Available) and what you have connected (Connected). Each connected account
// disconnects on its own, because a teammate may have more than one Google
// account and may want exactly one of them to keep access.
import { type ReactNode, useEffect, useState } from "react";
import { CalendarDays, Loader2, Mail, Search, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

export interface ConnectionService {
  id: "gmail" | "google-calendar";
  /** Product names, not copy: these are never translated. */
  label: string;
  detail: string;
  icon: ReactNode;
}

/** The shipped catalog. Adding a service later is a line here, not a new
 *  integration surface. */
export const CONNECTION_SERVICES: readonly ConnectionService[] = [
  {
    id: "gmail",
    label: "Gmail",
    detail: "Mercury reads connected mail and prepares drafts. Relay never sends email on its own.",
    icon: <Mail size={20} />,
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    detail: "Connected events appear read-only beside Relay's own bot schedule.",
    icon: <CalendarDays size={20} />,
  },
];

/** One authenticated Google account on a service. Tokens never reach the
 *  client, so the account is identified by the address Google reports and
 *  nothing else. */
export interface ConnectionAccount {
  service: ConnectionService["id"];
  id: string;
  email: string;
}

export type ConnectionView = "available" | "connected";

/** Which services land in which view. A service is Available until the signed-in
 *  teammate has at least one authenticated account on it, and Connected
 *  afterwards — one service, one row, whichever side of the pair it belongs on.
 *  Pure so the split is testable without driving the tab state. */
export function connectionViews(
  services: readonly ConnectionService[],
  accounts: readonly ConnectionAccount[],
  query = "",
) {
  const needle = query.trim().toLowerCase();
  const matches = (service: ConnectionService) =>
    !needle || `${service.label} ${service.detail}`.toLowerCase().includes(needle);

  const accountsByService = new Map<ConnectionService["id"], ConnectionAccount[]>();
  for (const account of accounts) {
    accountsByService.set(account.service, [...(accountsByService.get(account.service) ?? []), account]);
  }
  const connected = services.filter((service) => (accountsByService.get(service.id)?.length ?? 0) > 0);
  return {
    accountsByService,
    connected: connected.filter(matches),
    available: services.filter((service) => !accountsByService.get(service.id)?.length && matches(service)),
    connectedCount: connected.length,
  };
}

export interface PluginsPanelProps {
  /** What the signed-in teammate has already authorized. */
  accounts: readonly ConnectionAccount[];
  /** Per-service OAuth and token-store readiness from the BFF. */
  configured: Partial<Record<ConnectionService["id"], boolean>>;
  loading?: boolean;
  error?: string | null;
  onConnect: (service: ConnectionService["id"]) => void | Promise<void>;
  onDisconnect: (account: ConnectionAccount) => void | Promise<void>;
}

export function PluginsPanel({ accounts, configured, loading = false, error, onConnect, onDisconnect }: PluginsPanelProps) {
  const { dispatch } = useStore();
  const [view, setView] = useState<ConnectionView>(() => {
    if (typeof window === "undefined") return "available";
    return new URLSearchParams(window.location?.search ?? "").get("connections") === "connected"
      ? "connected"
      : "available";
  });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const close = () => dispatch({ type: "togglePlugins", open: false });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connections")) return;
    url.searchParams.delete("connections");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const { accountsByService, available, connected, connectedCount } = connectionViews(CONNECTION_SERVICES, accounts, query);

  const connect = async (service: ConnectionService["id"]) => {
    if (!configured[service] || pending) return;
    setPending(service);
    setActionError(null);
    try {
      await onConnect(service);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("connectors.action.failed"));
      setPending(null);
    }
  };

  const disconnect = async (account: ConnectionAccount) => {
    if (pending) return;
    const service = CONNECTION_SERVICES.find((candidate) => candidate.id === account.service);
    if (!service || !window.confirm(t("connectors.disconnectConfirm", { identity: `“${account.email}” (${account.id})`, service: service.label }))) return;
    setPending(account.id);
    setActionError(null);
    try {
      await onDisconnect(account);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("connectors.action.failed"));
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        data-tour="apps-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <h2 id="plugins-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("connectors.panelTitle")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("connectors.panelSubtitle")}</p>
          </div>
          <button
            data-tour="apps-close"
            onClick={close}
            aria-label={t("connectors.closeAria")}
            className="shrink-0 rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={21} />
          </button>
        </header>

        <div className="flex flex-col gap-3 border-b border-hairline/40 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex w-fit rounded-xl bg-raised/70 p-1" role="tablist" aria-label={t("connectors.viewAria")}>
            {(["available", "connected"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={view === option}
                onClick={() => setView(option)}
                className={cn(
                  "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                  view === option ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                {t(`connectors.view.${option}`)}
                {option === "connected" && connectedCount > 0 ? ` ${connectedCount}` : ""}
              </button>
            ))}
          </div>
          <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[260px]">
            <Search size={17} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("connectors.searchPlaceholder")}
              aria-label={t("connectors.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2 sm:px-8">
          {(error || actionError) && <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error ?? actionError}</p>}
          {loading && <div role="status" className="py-8 text-center text-[13px] text-ink-secondary">{t("connectors.empty.loadingTitle")}</div>}
          {!loading && view === "available"
            ? available.length === 0
              ? <EmptyState />
              : available.map((service) => (
                <ServiceRow key={service.id} service={service} action={
                  <button
                    type="button"
                    disabled={!configured[service.id] || pending !== null}
                    title={configured[service.id] ? undefined : t("connectors.notConfiguredYet")}
                    onClick={() => void connect(service.id)}
                    className="flex min-w-[88px] shrink-0 items-center justify-center rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                  >
                    {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : configured[service.id] ? t("connectors.action.connect") : t("connectors.comingSoon")}
                  </button>
                } />
              ))
            : null}
          {!loading && view === "connected" && (connected.length === 0
            ? <EmptyState connected />
            : connected.map((service) => (
                <ServiceRow key={service.id} service={service} action={
                  <button
                    type="button"
                    disabled={!configured[service.id] || pending !== null}
                    onClick={() => void connect(service.id)}
                    className="flex min-w-[112px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                  >
                    {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : t("connectors.action.addAccount")}
                  </button>
                }>
                  {(accountsByService.get(service.id) ?? []).map((account) => (
                    <div key={account.id} className="ml-14 mt-3 flex items-center gap-2 rounded-lg bg-raised/45 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-ink">{account.email}</div>
                        <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">{account.id}</div>
                      </div>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void disconnect(account)}
                        aria-label={t("connectors.disconnectAria", { account: account.email, service: service.label })}
                        className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        {pending === account.id ? <Loader2 size={13} className="animate-spin" /> : t("connectors.disconnect")}
                      </button>
                    </div>
                  ))}
                </ServiceRow>
              )))}
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ service, action, children }: {
  service: ConnectionService;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="border-b border-hairline/35 py-4 last:border-b-0">
      <div className="flex min-h-[56px] items-center gap-3 px-1">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary">
          {service.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{service.label}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{service.detail}</div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ connected = false }: { connected?: boolean }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center text-center">
      <div className="text-[14px] font-medium text-ink">
        {connected ? t("connectors.empty.noneTitle") : t("connectors.noAppsFound")}
      </div>
      <div className="mt-1 text-[12.5px] text-ink-secondary">
        {connected ? t("connectors.empty.noneBody") : t("connectors.tryDifferentSearch")}
      </div>
    </div>
  );
}
