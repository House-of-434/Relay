// "About Relay" — the version you are running and where to go next.
// Small on purpose: the interesting settings live in the settings panel, and
// this exists so a bug report can quote a version number.
import { useEffect, useRef } from "react";

import {
  APP_NAME,
  APP_REPOSITORY,
  appVersion,
  openExternalLink,
  platformLabel,
} from "@/lib/app-links";

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const platform = platformLabel(window.ogb?.platform);

  return (
    <div
      className="tactile-backdrop fixed inset-0 z-50 flex items-center justify-center p-6 max-md:items-end max-md:p-0"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        className="tactile-dialog w-full max-w-[360px] p-6 text-center max-md:w-full"
      >
        <div className="tactile-grab-handle -mt-3 mb-3" aria-hidden="true" />
        <img src="/app-icon.png" alt="" width={56} height={56} className="mx-auto size-14 rounded-2xl" />
        <h2 id="about-dialog-title" className="mt-3 text-[16px] leading-6 font-medium text-ink">
          {APP_NAME}
        </h2>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-[13px] leading-5 text-ink-secondary">
          <span>
            Version {appVersion()}
            {platform ? ` · ${platform}` : ""}
          </span>
          <span aria-hidden="true">·</span>
          <AboutLink href={APP_REPOSITORY} label="GitHub" />
        </p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="ui-button mt-5 w-full"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalLink(href)}
      className="text-accent hover:underline"
    >
      {label}
    </button>
  );
}
