import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Laptop, Loader2, Trash2 } from "lucide-react";
import { Card } from "./SettingsPrimitives";
import { ComputerSharingSettings } from "./ComputerSharingSettings";
import { useStore } from "@/state/store";
import { sharedComputersEnabled } from "@/lib/feature-flags";

type SavedWorkspaces = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;
type SavedEntry = { id: string; name: string; origin: string };

/** Logo tile for a server row, marketplace-style. The local row shows this
 * app's icon; a saved server shows its own icon with a letter fallback, so a
 * server that is unreachable or not a Relay keeps a clean row. */
function ServerMark({ entry }: { entry: SavedEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.id === "local") {
    return failed
      ? <Laptop size={20} aria-hidden="true" className="text-ink-secondary" />
      : <img src="/app-icon.png" alt="" width={22} height={22} onError={() => setFailed(true)} className="size-[22px] rounded-md" />;
  }
  let icon: string | null = null;
  try {
    icon = entry.origin ? `${new URL(entry.origin).origin}/app-icon.png` : null;
  } catch {
    icon = null;
  }
  if (!icon || failed) {
    return entry.name
      ? <span aria-hidden="true" className="text-[16px] font-semibold text-ink">{entry.name.slice(0, 1).toUpperCase()}</span>
      : <Cloud size={20} aria-hidden="true" className="text-ink-secondary" />;
  }
  return <img src={icon} alt="" width={22} height={22} onError={() => setFailed(true)} className="size-[22px] rounded-md" />;
}

/** These are this desktop's connections, not a fleet administration API. */
export function ConnectedWorkspacesSettings() {
  const bridge = window.ogb?.environments;
  // Computer sharing is off unless this workspace's server turned it on. The
  // desktop bridge alone is not enough: never offer access the server refuses.
  const { state } = useStore();
  const sharingOffered = sharedComputersEnabled(state.config) && Boolean(window.ogb?.computerSharing);
  const [saved, setSaved] = useState<SavedWorkspaces | null>(null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Two failures, never one: the list the card renders and the action the
  // form submits are separate problems with separate sentences.
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [computerId, setComputerId] = useState<string | null>(() => new URLSearchParams(window.location?.search ?? "").get("share-computer"));
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void bridge?.state().then((state) => { if (generation.current === current) setSaved(state); })
      .catch(() => { if (generation.current === current) setLoadFailed(true); });
    return () => { generation.current++; };
  }, [bridge]);
  useEffect(() => {
    const consume = (id?: string | null) => {
      if (id) setComputerId(id);
      const url = new URL(window.location.href);
      url.searchParams.delete("share-computer");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    };
    consume();
    return bridge?.onOpenSettings?.(consume);
  }, [bridge]);
  const perform = async (action: () => Promise<unknown>) => {
    if (pending.current || !bridge) return;
    pending.current = true; setBusy(true); setError("");
    const current = generation.current;
    try {
      // A successful switch/connect unloads this local renderer. Do not ask
      // for its privileged saved list again after the active origin changes.
      if (await action() !== true) {
        // Reading the list back is a load of its own, never the action's
        // own failure: a broken read says the list is unavailable and
        // leaves the action's message to say what the action hit.
        try {
          const state = await bridge.state();
          if (generation.current === current) { setSaved(state); setLoadFailed(false); }
        } catch {
          if (generation.current === current) setLoadFailed(true);
        }
      }
    } catch (nextError) {
      if (generation.current === current) setError(String((nextError as Error)?.message ?? nextError)
        .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };
  if (!bridge) return <p className="text-[13px] text-ink-secondary">Manage server connections in the desktop app.</p>;
  const computerWorkspace = saved?.environments.find(entry => entry.id === computerId);
  return <>
    <p className="text-[13px] leading-relaxed text-ink-secondary">One desktop app, wherever your bots live. Switching servers does not move or replace your bots, conversations, or provider accounts.</p>
    <Card title="Your servers" subtitle="Saved on this computer. Your hosted bots keep running when you switch away.">
      {!saved
        ? loadFailed
          ? <div className="flex flex-wrap items-center gap-3 rounded-lg bg-danger/10 px-3 py-2">
              <p role="alert" className="min-w-0 flex-1 text-[12px] text-danger">Saved servers could not be loaded.</p>
              <button type="button" disabled={busy} onClick={() => void perform(() => Promise.resolve())}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}Retry
              </button>
            </div>
          : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />Loading servers…</p>
        : <ul className="divide-y divide-hairline/40">
          {[{ id: "local", name: "This computer", origin: "" }, ...saved.environments].map((entry) => {
            const active = entry.id === saved.activeId;
            return <li key={entry.id} className="flex min-h-[56px] items-center gap-3 py-3">
              <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-raised">
                <ServerMark key={`${entry.id}${entry.origin}`} entry={entry} />
              </span>
              <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium text-ink">{entry.name}</div>
                <div className="mt-0.5 break-all text-[12px] leading-relaxed text-ink-secondary">{entry.origin || "Local bots and conversations"}</div></div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {active
                  ? <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-1 text-[11px] font-medium text-success"><Check size={11} />Current</span>
                  : <button type="button" disabled={busy} aria-label={`Switch to ${entry.name}`} onClick={() => void perform(async () => { await bridge.switch(entry.id); return true; })}
                    className="rounded-full bg-raised px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40">Switch</button>}
                {entry.id !== "local" && sharingOffered && <button type="button" disabled={busy} aria-label={`Computer access for ${entry.name}`} onClick={() => setComputerId(entry.id)}
                  className="rounded-full px-2.5 py-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-control hover:text-ink disabled:opacity-40">Computer access</button>}
                {entry.id !== "local" && <button type="button" disabled={busy} aria-label={`Forget ${entry.name}`} title={`Forget ${entry.name}`}
                  onClick={() => void perform(() => bridge.forget(entry.id))} className="rounded-lg p-2 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>}
              </div>
            </li>;
          })}
        </ul>}
    </Card>
    {sharingOffered && computerWorkspace && <ComputerSharingSettings key={computerWorkspace.id} workspace={computerWorkspace} onClose={() => setComputerId(null)} />}
    <Card title="Connect to a server" subtitle="Already running Relay on a VPS, server, or another computer? Connect it here.">
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (address.trim()) void perform(() => bridge.addFromLink(address.trim(), name.trim()));
      }}>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Server address or pairing link
          <input required value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)}
            placeholder="https://bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">Name (optional)
          <input value={name} disabled={busy} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="My server"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50" />
        </label>
        <p className="text-[12px] leading-relaxed text-ink-secondary">Paste a pairing link from your server’s Settings → Remote access, or enter its address and sign in there. Your desktop stays connected afterward.</p>
        <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Need a pairing code?</summary>
          <p className="mt-2">Run this on the server and copy the link it prints:</p>
          <code className="mt-1 block select-all break-words rounded-md bg-inset px-2 py-2 text-ink">npx relay pair --label "My desktop"</code>
        </details>
        {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        <button type="submit" disabled={busy || !address.trim()} className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />}Connect
        </button>
      </form>
    </Card>
  </>;
}
