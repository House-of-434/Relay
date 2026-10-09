// The handful of outward links the app offers, collected here so every
// call site points at the same destination. All of them live under the
// House of 434 repo.
export const APP_NAME = "Relay";
export const APP_REPOSITORY = "https://github.com/House-of-434/Relay";
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs`;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;

/** The version Vite inlined from package.json; "dev" when the define is
 * missing (a bare `tsc`/test run outside the bundler). */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** "macOS", "Windows", "Linux" — or nothing at all in the browser, where the
 * host OS is not ours to claim. */
export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

/** Hands a link to the default browser through the preload bridge, falling
 * back to a new tab when the app runs in a plain browser. */
export async function openExternalLink(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
