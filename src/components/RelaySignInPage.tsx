import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

/** Shown only by the web BFF when the browser has no Relay session. Desktop
 * pairing and local-owner flows keep their existing PairPage.
 *
 * This answers one question — how do I get into Relay? — and stops. It says
 * nothing about the agents (the sidebar introduces them once you are in) and
 * nothing about mail or calendar access: the guided tour explains that at the
 * moment it matters, which is a better place than a footnote nobody reads. */
export function RelaySignInPage() {
  const [opening, setOpening] = useState(false);
  const denied = typeof window !== "undefined" &&
    new URLSearchParams(window.location?.search ?? "").get("authError") === "not-allowed";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-5 py-10 text-ink">
      <section className="w-full max-w-[400px] rounded-[20px] border border-hairline/50 bg-panel px-7 py-8 shadow-xl shadow-black/20 sm:px-9 sm:py-9">
        <div className="flex flex-col items-center text-center">
          <div aria-hidden="true" className="flex size-11 items-center justify-center rounded-2xl bg-accent text-[17px] font-bold text-white">R</div>
          <h1 className="mt-5 text-[19px] font-semibold tracking-tight">{t("signIn.workspace.title")}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            {t("signIn.workspace.body")}
          </p>
        </div>

        {denied && (
          <p role="alert" className="mt-6 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
            {t("signIn.workspace.denied")}
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
          {t("signIn.workspace.continue")}
        </a>
      </section>
    </main>
  );
}
