/** One persistent browser context per worker process, one page per capture.
 *
 * The signed-in Scribe profile is single-instance: a second
 * launchPersistentContext on the same dir fails on the profile lock. So all
 * captures share one context and each takes its own tab (verified live: one
 * signed-in account can sit in two meetings in two tabs). Page-level
 * isolation (separate JS worlds, separate audio graphs) keeps captures from
 * disturbing each other; the navigation guard installs per page for the same
 * reason — a context-wide route plus a single launch-time DNS pin cannot
 * serve two meetings on different hosts.
 *
 * Single-flight: concurrent first joins share one launch. A failed launch
 * clears the cached promise so the next join retries instead of inheriting
 * a permanently rejected context.
 */
import { chromium, type BrowserContext } from "playwright";

export interface SharedBrowserOptions {
  profileDir: string;
  headless: boolean;
  args: string[];
  locale: string;
  /** Test seam: replaces the real Chromium launch. */
  launch?: (options: {
    profileDir: string;
    headless: boolean;
    args: string[];
    locale: string;
  }) => Promise<BrowserContext>;
}

let shared: Promise<BrowserContext> | null = null;

export function sharedBrowserContext(options: SharedBrowserOptions): Promise<BrowserContext> {
  shared ??= (async () => {
    try {
      const launch = options.launch ?? ((launchOptions) => chromium.launchPersistentContext(
        launchOptions.profileDir,
        {
          headless: launchOptions.headless,
          args: launchOptions.args,
          locale: launchOptions.locale,
        },
      ));
      return await launch({
        profileDir: options.profileDir,
        headless: options.headless,
        args: options.args,
        locale: options.locale,
      });
    } catch (error) {
      shared = null;
      throw error;
    }
  })();
  return shared;
}

/** Test seam only: drop the cached context between tests. */
export function resetSharedBrowserContextForTests(): void {
  shared = null;
}
