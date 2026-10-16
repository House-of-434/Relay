// Relay's connections marketplace.
//
// The catalog is Relay's, not the user's: Gmail, Google Calendar, and GitHub
// ship preconfigured, and a teammate's job is to authenticate their own account
// against one of them. There is no connector marketplace to browse and no
// teammate-managed MCP server list — Relay mounts its own agent routes from the
// workspace, so reaching data beyond these services is a request to the team
// who runs the workspace.
//
// Two views, the pair this panel has always had: what you can connect
// (Available) and what you have connected (Connected). A connected service is
// one row whose action disconnects it, never a list of accounts to choose
// between. GitHub differs only in where its connection state comes from: the
// BFF reports it (there can be several installations), so its row is derived
// from that authoritative response rather than from the Google account list.
import { type ReactNode, useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { GithubMark, GmailMark, GoogleCalendarMark } from "./ProviderIcons";

export interface ConnectionService {
  id: "gmail" | "google-calendar" | "github";
  /** Product names, not copy: these are never translated. */
  label: string;
  detail: string;
  icon: ReactNode;
}

/** The shipped catalog. Adding a service later is a line here, not a new
 *  integration surface. Details state the permission boundary in plain
 *  language: what Relay may read or change on the teammate's behalf while
 *  the grant lasts. */
export const CONNECTION_SERVICES: readonly ConnectionService[] = [
  {
    id: "gmail",
    label: "Gmail",
    detail: "Relay can read and search your mail, and send email for you. Sending asks for confirmation first.",
    icon: <GmailMark size={22} />,
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    detail: "Relay can read your primary calendar and manage its events — creating, rescheduling, or cancelling when you ask.",
    icon: <GoogleCalendarMark size={22} />,
  },
];

/** GitHub joins the catalog only once the workspace is configured for it, so an
 *  unconfigured workspace shows no row at all rather than a dead Connect. It is
 *  a user-managed connection like the Google services; the install flow decides
 *  which repositories Relay may read. */
export const GITHUB_SERVICE: ConnectionService = {
  id: "github",
  label: "GitHub",
  detail: "Relay can read the repositories, issues, and releases you grant. Connecting authorizes the installation on GitHub first.",
  icon: <GithubMark size={22} />,
};

/** One authenticated Google account on a service. Tokens never reach the
 *  client, so the account is identified by the address Google reports and
 *  nothing else. */
export interface ConnectionAccount {
  service: ConnectionService["id"];
  id: string;
  email: string;
}

export type ConnectionView = "available" | "connected";

/** Which services land in which view. A service is Available until it is
 *  connected and Connected afterwards — one service, one row, whichever side of
 *  the pair it belongs on. Google services count as connected once the teammate
 *  has an authenticated account; GitHub's connection state is not an account
 *  list, so the BFF reports it and the caller passes those ids in
 *  `connectedExternally`. Pure so the split is testable without driving the tab
 *  state. */
export function connectionViews(
  services: readonly ConnectionService[],
  accounts: readonly ConnectionAccount[],
  query = "",
  connectedExternally: ReadonlySet<ConnectionService["id"]> = new Set(),
) {
  const needle = query.trim().toLowerCase();
  const matches = (service: ConnectionService) =>
    !needle || `${service.label} ${service.detail}`.toLowerCase().includes(needle);

  const accountsByService = new Map<ConnectionService["id"], ConnectionAccount[]>();
  for (const account of accounts) {
    accountsByService.set(account.service, [...(accountsByService.get(account.service) ?? []), account]);
  }
  const isConnected = (service: ConnectionService) =>
    (accountsByService.get(service.id)?.length ?? 0) > 0 || connectedExternally.has(service.id);
  return {
    accountsByService,
    connected: services.filter(isConnected).filter(matches),
    available: services.filter((service) => !isConnected(service) && matches(service)),
  };
}

/** GitHub's connection as the BFF reports it: whether the workspace is set up
 *  for it, whether the teammate has linked an installation, and the
 *  installations Disconnect must revoke. */
export interface GithubConnection {
  configured: boolean;
  connected: boolean;
  account?: string;
  connections: readonly { id: string; account: string }[];
}

export interface PluginsPanelProps {
  /** What the signed-in teammate has already authorized. */
  accounts: readonly ConnectionAccount[];
  /** Per-service OAuth and token-store readiness from the BFF. */
  configured: Partial<Record<ConnectionService["id"], boolean>>;
  loading?: boolean;
  error?: string | null;
  onConnect: (service: ConnectionService["id"]) => void | Promise<void>;
  /** Revokes every grant held on one service: the panel's rows are services,
   *  so its Disconnect is service-scoped too. */
  onDisconnect: (accounts: readonly ConnectionAccount[]) => void | Promise<void>;
  /** GitHub's connection state from the BFF. Omitted until it is known, so the
   *  panel renders exactly as before GitHub existed. */
  github?: GithubConnection;
  onConnectGithub?: () => void | Promise<void>;
  onDisconnectGithub?: () => void | Promise<void>;
}

export function PluginsPanel({
  accounts, configured, loading = false, error, onConnect, onDisconnect,
  github, onConnectGithub, onDisconnectGithub,
}: PluginsPanelProps) {
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

  // GitHub joins the catalog only when the workspace is configured for it; an
  // unconfigured workspace shows no row at all rather than a dead Connect.
  const githubConfigured = Boolean(github?.configured);
  const services: readonly ConnectionService[] = githubConfigured
    ? [...CONNECTION_SERVICES, GITHUB_SERVICE]
    : CONNECTION_SERVICES;
  const externallyConnected = new Set<ConnectionService["id"]>(github?.connected ? ["github"] : []);
  const { accountsByService, available, connected } = connectionViews(services, accounts, query, externallyConnected);

  const isConfigured = (service: ConnectionService) =>
    service.id === "github" ? githubConfigured : Boolean(configured[service.id]);

  const connect = async (service: ConnectionService) => {
    if (!isConfigured(service) || pending) return;
    setPending(service.id);
    setActionError(null);
    try {
      // GitHub's Connect leaves Relay for GitHub, so like Google's it resolves
      // only on failure; a success navigates the browser away.
      await (service.id === "github" ? onConnectGithub?.() : onConnect(service.id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("connectors.action.failed"));
      setPending(null);
    }
  };

  // A connected service is a single row whose Disconnect removes the service
  // from Relay — every grant held on it, so a leftover second account or
  // installation cannot keep serving data behind a confirmation that says
  // access ends.
  const disconnect = async (service: ConnectionService, accounts: readonly ConnectionAccount[]) => {
    if (pending) return;
    if (!window.confirm(t("connectors.disconnectConfirm", { service: service.label }))) return;
    setPending(service.id);
    setActionError(null);
    try {
      await (service.id === "github" ? onDisconnectGithub?.() : onDisconnect(accounts));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("connectors.action.failed"));
    } finally {
      setPending(null);
    }
  };

  // GitHub is the one row that names its connected account: its identity comes
  // from the installation the BFF reported, not from the Google account list.
  const rowNote = (service: ConnectionService) =>
    service.id === "github" && github?.account
      ? t("connectors.github.connected", { account: github.account })
      : undefined;

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
                <ServiceRow key={service.id} service={service} note={rowNote(service)} action={
                  <button
                    type="button"
                    disabled={!isConfigured(service) || pending !== null}
                    title={isConfigured(service) ? undefined : t("connectors.notConfiguredYet")}
                    aria-label={t("connectors.connectAria", { service: service.label })}
                    onClick={() => void connect(service)}
                    className="flex min-w-[88px] shrink-0 items-center justify-center rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                  >
                    {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : isConfigured(service) ? t("connectors.action.connect") : t("connectors.comingSoon")}
                  </button>
                } />
              ))
            : null}
          {!loading && view === "connected" && (connected.length === 0
            ? <EmptyState connected />
            : connected.map((service) => {
                const accounts = accountsByService.get(service.id) ?? [];
                return (
                  <ServiceRow key={service.id} service={service} note={rowNote(service)} action={
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => void disconnect(service, accounts)}
                      aria-label={t("connectors.disconnectAria", { service: service.label })}
                      className="flex min-w-[112px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                    >
                      {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : t("connectors.disconnect")}
                    </button>
                  } />
                );
              }))}
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ service, action, note }: {
  service: ConnectionService;
  action: ReactNode;
  note?: string;
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
          {note && <div className="mt-0.5 text-[12px] text-ink-secondary">{note}</div>}
        </div>
        {action}
      </div>
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
