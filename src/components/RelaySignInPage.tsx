import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

/** Shown only by the web BFF when the browser has no Relay session. Desktop
 * pairing and local-owner flows keep their existing PairPage. */
export function RelaySignInPage() {
  const [opening, setOpening] = useState(false);
  const denied = typeof window !== "undefined" &&
    new URLSearchParams(window.location?.search ?? "").get("authError") === "not-allowed";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-5 py-10 text-ink">
      <section className="w-full max-w-[420px] rounded-[24px] border border-hairline/50 bg-panel p-7 shadow-xl shadow-black/20 sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <div aria-hidden="true" className="flex size-11 items-center justify-center rounded-2xl bg-accent text-[17px] font-bold text-white">R</div>
          <div>
            <div className="text-[17px] font-semibold tracking-tight">Relay</div>
            <div className="text-[12px] text-ink-secondary">House of 434 workspace</div>
          </div>
        </div>

        <h1 className="text-[23px] font-semibold tracking-tight">Sign in to Relay</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
          Use your House of 434 Google account. Signing in identifies you; Gmail and Calendar access are connected separately in Connections.
        </p>

        {denied && (
          <p role="alert" className="mt-5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger">
            This Google account is not authorized for the House of 434 workspace. Sign in with your company account.
          </p>
        )}

        <a
          href="/auth/login"
          aria-disabled={opening}
          onClick={(event) => {
            if (opening) {
              event.preventDefault();
              return;
            }
            setOpening(true);
          }}
          className="mt-7 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[14px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel aria-disabled:cursor-wait aria-disabled:opacity-70"
        >
          {opening ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
          Continue with Google
        </a>

        <p className="mt-5 text-center text-[11.5px] leading-relaxed text-ink-tertiary">
          Google sign-in does not grant Relay access to your mailbox or calendar. You choose those connections separately.
        </p>
      </section>
    </main>
  );
}
