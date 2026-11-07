// Relay's connections marketplace.
//
// The catalog is Relay's, not the user's: Gmail, Google Calendar, and GitHub
// ship preconfigured, and a teammate's job is to authenticate their own account
// against one of them. There is no connector marketplace to browse and no
// teammate-managed MCP server list — Relay mounts its own agent routes from the
// workspace, so reaching data beyond these services is a request to the team
// who runs the workspace.
//
// One list of the shipped services: each row's action is the state of that
// service (a Connect for what is not connected yet, a Disconnect once it is),
// never a list of accounts to choose between. GitHub and Notion differ only
// in where their connection state comes from: the BFF reports it (there can
// be several installations or workspaces), so their rows are derived from
// that authoritative response rather than from the Google account list.
import { type ReactNode, useState } from "react";
import { ChevronLeft, Loader2, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { GithubMark, GmailMark, GoogleCalendarMark, NotionMark } from "./ProviderIcons";

export interface ConnectionService {
  id: "gmail" | "google-calendar" | "github" | "notion";
  /** Product names, not copy: these are never translated. */
  label: string;
  detail: string;
  icon: ReactNode;
  category: "Coding" | "Productivity";
  /** What the service does for the bots, in plain language. */
  about: string;
  /** Concrete ways a teammate would use the connection. */
  usage: readonly string[];
}

/** The shipped catalog. Adding a service later is a line here, not a new
 *  integration surface. Details state the permission boundary in plain
 *  language: what Relay may read or change on the teammate's behalf while
 *  the grant lasts. */
export const CONNECTION_SERVICES: readonly ConnectionService[] = [
  {
    id: "gmail",
    label: "Gmail",
    detail: "Emails, summaries",
    category: "Productivity",
    about: "Your mailbox, usable by your bots. Search, read, and summarize mail, and send email on your behalf — sending always asks for your confirmation first.",
    usage: ["Summarize unread mail before you start the day", "Find a receipt, attachment, or old thread by subject", "Draft and send updates in your voice"],
    icon: <GmailMark size={22} />,
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    detail: "Events, schedules",
    category: "Productivity",
    about: "Your primary calendar, readable and manageable by your bots. See what is coming up, and create, reschedule, or cancel events when you ask.",
    usage: ["Ask what your day looks like", "Book a follow-up or move a meeting", "Find a free slot across your week"],
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
  detail: "Repos, issues, releases",
  category: "Coding",
  about: "The repositories you grant access to, readable by your bots. They can explore code, open and track issues, and read releases — the install decides which repos are in scope.",
  usage: ["Ask what changed in a repo this week", "Open an issue from a bug you describe", "Read release notes without opening GitHub"],
  icon: <GithubMark size={22} />,
};

/** Notion joins the catalog only once the workspace is configured for it, like
 *  GitHub. Connecting authorizes the teammate's own workspace through Notion's
 *  OAuth screen, where they choose which pages Relay may read and update. */
export const NOTION_SERVICE: ConnectionService = {
  id: "notion",
  label: "Notion",
  detail: "Pages, databases",
  category: "Productivity",
  about: "The Notion workspaces you connect, searchable and updatable by your bots. Pages and databases — including the Dealflow database — can be read, searched, and written back.",
  usage: ["Ask what a page says without opening Notion", "Search across connected workspaces", "Add or update rows in a database"],
  icon: <NotionMark size={22} />,
};

/** One authenticated Google account on a service. Tokens never reach the
 *  client, so the account is identified by the address Google reports and
 *  nothing else. */
export interface ConnectionAccount {
  service: ConnectionService["id"];
  id: string;
  email: string;
}

/** Splits the matching services into connected and not-yet-connected so the
 *  panel can pick each row's action. Google services count as connected once
 *  the teammate has an authenticated account; GitHub's connection state is
 *  not an account list, so the BFF reports it and the caller passes those ids
 *  in `connectedExternally`. Pure so the split is testable on its own. */
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

/** Notion's connection as the BFF reports it: whether the workspace is set up
 *  for it, whether the teammate has linked a workspace, and the workspaces
 *  Disconnect must revoke. */
export interface NotionConnection {
  configured: boolean;
  connected: boolean;
  workspace?: string;
  connections: readonly { id: string; workspace: string }[];
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
  /** Notion's connection state from the BFF. Omitted until it is known, so
   *  unconfigured workspaces show no row at all rather than a dead Connect. */
  notion?: NotionConnection;
  onConnectNotion?: () => void | Promise<void>;
  onDisconnectNotion?: () => void | Promise<void>;
}

export function PluginsPanel({
  accounts, configured, loading = false, error, onConnect, onDisconnect,
  github, onConnectGithub, onDisconnectGithub,
  notion, onConnectNotion, onDisconnectNotion,
}: PluginsPanelProps) {
  const { dispatch } = useStore();
  const [selectedId, setSelectedId] = useState<ConnectionService["id"] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const close = () => dispatch({ type: "togglePlugins", open: false });



  // GitHub and Notion join the catalog only when the workspace is configured
  // for them; an unconfigured workspace shows no row at all rather than a
  // dead Connect.
  const githubConfigured = Boolean(github?.configured);
  const notionConfigured = Boolean(notion?.configured);
  const services: readonly ConnectionService[] = [
    ...CONNECTION_SERVICES,
    ...(githubConfigured ? [GITHUB_SERVICE] : []),
    ...(notionConfigured ? [NOTION_SERVICE] : []),
  ];
  const externallyConnected = new Set<ConnectionService["id"]>([
    ...(github?.connected ? ["github" as const] : []),
    ...(notion?.connected ? ["notion" as const] : []),
  ]);
  const { accountsByService, available, connected } = connectionViews(services, accounts, "", externallyConnected);
  const connectedIds = new Set(connected.map((service) => service.id));
  const visibleIds = new Set([...available, ...connected].map((service) => service.id));
  const visibleServices = services.filter((service) => visibleIds.has(service.id));

  const isConfigured = (service: ConnectionService) =>
    service.id === "github" ? githubConfigured : service.id === "notion" ? notionConfigured : Boolean(configured[service.id]);

  const connect = async (service: ConnectionService) => {
    if (!isConfigured(service) || pending) return;
    setPending(service.id);
    setActionError(null);
    try {
      // GitHub's and Notion's Connect leave Relay for the provider, so like
      // Google's they resolve only on failure; a success navigates away.
      if (service.id === "github") await onConnectGithub?.();
      else if (service.id === "notion") await onConnectNotion?.();
      else await onConnect(service.id);
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
      if (service.id === "github") await onDisconnectGithub?.();
      else if (service.id === "notion") await onDisconnectNotion?.();
      else await onDisconnect(accounts);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("connectors.action.failed"));
    } finally {
      setPending(null);
    }
  };

  const selected = selectedId ? services.find((service) => service.id === selectedId) : undefined;
  const CATEGORY_ORDER = ["Coding", "Productivity"] as const;
  const categories = [...new Set(visibleServices.map((service) => service.category))]
    .sort((left, right) => CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right));

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

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2 sm:px-8">
          {(error || actionError) && <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error ?? actionError}</p>}
          {loading && <div role="status" className="py-8 text-center text-[13px] text-ink-secondary">{t("connectors.empty.loadingTitle")}</div>}
          {!loading && selected ? (
            <ServiceDetail
              service={selected}
              connected={connectedIds.has(selected.id)}
              configured={isConfigured(selected)}
              pending={pending}
              onBack={() => setSelectedId(null)}
              onConnect={() => void connect(selected)}
              onDisconnect={() => void disconnect(selected, accountsByService.get(selected.id) ?? [])}
            />
          ) : !loading && (visibleServices.length === 0
            ? <EmptyState />
            : categories.map((category) => (
              <section key={category} aria-label={category}>
                <h3 className="mt-4 flex items-baseline gap-2 text-[13px] font-semibold text-ink">
                  {category}
                  <span className="text-[12px] font-normal text-ink-secondary">
                    {visibleServices.filter((service) => service.category === category).length}
                  </span>
                </h3>
                <div>
                  {visibleServices
                    .filter((service) => service.category === category)
                    .map((service) => (
                      <ServiceRow
                        key={service.id}
                        service={service}
                        onOpen={() => setSelectedId(service.id)}
                        action={
                          connectedIds.has(service.id)
                            ? (
                              <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => void disconnect(service, accountsByService.get(service.id) ?? [])}
                                aria-label={t("connectors.disconnectAria", { service: service.label })}
                                className="flex min-w-[112px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                              >
                                {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : t("connectors.disconnect")}
                              </button>
                            )
                            : (
                              <button
                                type="button"
                                disabled={!isConfigured(service) || pending !== null}
                                title={isConfigured(service) ? undefined : t("connectors.notConfiguredYet")}
                                aria-label={t("connectors.connectAria", { service: service.label })}
                                onClick={() => void connect(service)}
                                className="flex min-w-[88px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                              >
                                {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : null}
                                {isConfigured(service) ? t("connectors.action.connect") : t("connectors.comingSoon")}
                              </button>
                            )
                        }
                      />
                    ))}
                </div>
              </section>
            )))}
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ service, action, onOpen }: {
  service: ConnectionService;
  action: ReactNode;
  onOpen: () => void;
}) {
  return (
    <section>
      <div className="flex min-h-[56px] items-center gap-3 px-1 py-3">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${service.label}: ${service.detail}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary">
            {service.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{service.label}</span>
            <span className="mt-0.5 block truncate text-[12.5px] leading-relaxed text-ink-secondary">{service.detail}</span>
          </span>
        </button>
        {action}
      </div>
    </section>
  );
}

function ServiceDetail({ service, connected, configured, pending, onBack, onConnect, onDisconnect }: {
  service: ConnectionService;
  connected: boolean;
  configured: boolean;
  pending: string | null;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="py-2">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <ChevronLeft size={15} /> Back
      </button>
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary">
          {service.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold text-ink">{service.label}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{service.detail}</div>
        </div>
        {connected ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={onDisconnect}
            aria-label={t("connectors.disconnectAria", { service: service.label })}
            className="flex min-w-[112px] shrink-0 items-center justify-center rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
          >
            {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : t("connectors.disconnect")}
          </button>
        ) : (
          <button
            type="button"
            disabled={!configured || pending !== null}
            title={configured ? undefined : t("connectors.notConfiguredYet")}
            aria-label={t("connectors.connectAria", { service: service.label })}
            onClick={onConnect}
            className="flex min-w-[88px] shrink-0 items-center justify-center rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
          >
            {pending === service.id ? <Loader2 size={14} className="animate-spin" /> : null}
            {configured ? t("connectors.action.connect") : t("connectors.comingSoon")}
          </button>
        )}
      </div>
      <div className="mt-4">
        <p className="text-[13px] leading-relaxed text-ink">{service.about}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-ink">
          {service.usage.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center text-center">
      <div className="text-[14px] font-medium text-ink">
        {t("connectors.empty.noneTitle")}
      </div>
      <div className="mt-1 text-[12.5px] text-ink-secondary">
        {t("connectors.empty.noneBody")}
      </div>
    </div>
  );
}
