import { useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

/** Shown only by the web BFF when the browser has no Relay session. Desktop
 * pairing and local-owner flows keep their existing PairPage.
 *
 * Minimal and classy: the app background, a soft blurred orb behind a crisp
 * orb, "House of 434" up top, one white pill to continue. No cards, no
 * chevrons, no toggles. */
export function RelaySignInPage() {
  const [opening, setOpening] = useState(false);
  const denied = typeof window !== "undefined" &&
    new URLSearchParams(window.location?.search ?? "").get("authError") === "not-allowed";

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-app px-5 py-10 text-ink">
      {/* Blurred stacks watermark — same theme background, just depth */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <StacksMark className="size-[420px] opacity-20 blur-3xl" />
      </div>

      <header className="relative flex flex-col items-center text-center">
        <h1
          className="text-[44px] font-medium leading-none sm:text-[52px]"
          style={{
            fontFamily: '"Inter Tight", "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
            letterSpacing: "-0.03em",
          }}
        >
          Relay
        </h1>
      </header>

      {/* The two stacks only — no tile, background stays the theme */}
      <div className="relative flex items-center justify-center py-16">
        <StacksMark className="h-[148px] w-auto" />
      </div>

      <div className="relative mt-4 flex w-full flex-col items-center">

      {denied && (
        <p role="alert" className="relative mb-6 max-w-[340px] rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-center text-[12.5px] leading-relaxed text-danger">
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
        className="relative flex min-h-11 w-full max-w-[280px] items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-[14px] font-medium text-black transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black aria-disabled:cursor-wait aria-disabled:opacity-70"
      >
        {opening ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <GoogleG />}
        {t("signIn.workspace.continue")}
      </a>

      <a
        href="https://www.houseof434.com"
        target="_blank"
        rel="noopener noreferrer"
        className="relative mt-4 text-[12px] tracking-wide text-ink-secondary/70 underline-offset-4 hover:underline"
      >
        House of 434
      </a>
      </div>
    </main>
  );
}

/** The two mint stacks from the app icon, drawn without the dark tile so the
 * theme background shows through. Proportions match public/app-icon.png:
 * identical parallelograms with a clear gap between them. */
function StacksMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 156" fill="none" aria-hidden="true" className={className}>
      <path
        d="M78 8h104a18 18 0 0 1 13.4 30L164 62a30 30 0 0 1-22.3 10H38a18 18 0 0 1-13.4-30L56 18A30 30 0 0 1 78 8Z"
        fill="#9AD7B2"
      />
      <path
        d="M78 92h104a18 18 0 0 1 13.4 30l-31.4 24a30 30 0 0 1-22.3 10H38a18 18 0 0 1-13.4-30l31.4-24A30 30 0 0 1 78 92Z"
        fill="#9AD7B2"
      />
    </svg>
  );
}

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="#4285F4" d="M15.5 8.2c0-.55-.05-1.08-.14-1.59H8v3.01h4.21a3.6 3.6 0 0 1-1.56 2.36v1.96h2.53c1.48-1.36 2.32-3.37 2.32-5.74Z" />
      <path fill="#34A853" d="M8 16c2.1 0 3.87-.7 5.16-1.89l-2.53-1.96c-.7.47-1.6.75-2.63.75-2.02 0-3.73-1.36-4.34-3.2H1.03v2.02A8 8 0 0 0 8 16Z" />
      <path fill="#FBBC05" d="M3.66 9.7a4.8 4.8 0 0 1 0-3.05V4.63H1.03a8 8 0 0 0 0 7.09l2.63-2.02Z" />
      <path fill="#EA4335" d="M8 3.3c1.14 0 2.17.4 2.98 1.17l2.24-2.24A8 8 0 0 0 1.03 4.63l2.63 2.02c.61-1.84 2.32-3.2 4.34-3.2Z" />
    </svg>
  );
}
