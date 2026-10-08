/** Bladebro daemon lifecycle policy: one daemon per user workspace.
 *
 * BLADE_HOME alone is a directory, not process isolation. This module is
 * the rest of the contract the adapter (`infra/bladebro.ts`) implements:
 *
 * - daemon multiplexing by data root: Bladebro keeps one daemon per
 *   BLADE_HOME behind a socket in that root (`cli.sock`), so two users can
 *   never share a daemon by construction. Verified by spike: two
 *   BLADE_HOMEs run concurrently with separate daemons, no ports involved.
 *   (An earlier revision reserved TCP ports 18600–18699; the CLI surface
 *   binds none — ports would require the forbidden --host/--port attach —
 *   so the reservation was removed rather than kept as dead policy.)
 * - first-spawn races are serialized by Bladebro's native data-root lock
 *   (`cli.pid`; surfaced by `bladebro doctor`'s lock check), not by us:
 *   serializing same-user calls here would kill Scout's parallel fan-out.
 * - crash recovery is native: the daemon self-heals dead refs, tabs, and
 *   relaunches crashed Chrome transparently.
 * - what WE own: the env allowlist, the lane ban, the idle-reclaim budget,
 *   the daemon ceiling, and artifact containment.
 *
 * Everything here is pure and tested offline.
 */

import { join } from "node:path";

/** Daemon ceiling: one per active user workspace, sized for the ~10-person
 * team with headroom. The adapter refuses new daemons past this instead of
 * exhausting the host. */
export const MAX_BLADE_DAEMONS = 12;

/** Idle workspaces are reclaimed after this long without a browser call.
 * Matches Bladebro's own BLADE_IDLE_TIMEOUT default (600s). */
export const BLADE_IDLE_RECLAIM_MS = 10 * 60_000;

/** Daemon start budget: fail the call instead of hanging the turn. */
export const BLADE_START_TIMEOUT_MS = 60_000;

/** Single browser-action budget, inherited from browser-proxy.ts. */
export const BLADE_ACTION_TIMEOUT_MS = 130_000;

/** The only BLADE_* variables the adapter may place in a daemon's
 * environment. Anything else — notably lane overrides, real-browser
 * settings, and BLADE_HOME taken from ambient env — is never forwarded. */
export const BLADE_ALLOWED_ENV = [
  "BLADE_HOME",
  "BLADE_FRESH",
  "BLADE_NO_UPDATE_CHECK",
  "BLADE_NO_COMPRESS",
  "BLADE_CONSENT",
  "BLADE_IDLE_TIMEOUT",
  "BLADE_CMD_TIMEOUT",
  "BLADE_TZ",
  "BLADE_LOCALE",
  "BLADE_PROXY",
  "PATH",
  "CHROME_PATH",
] as const;

/** Artifacts directory: nested under the user's workspace so page extracts
 * and downloads can never land in — or be mistaken for — shared storage.
 * See plans/scout-research.md for the shared-store boundary this enforces. */
export function artifactsDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, "artifacts");
}

/** Real-browser lane and foreign endpoints are forbidden on a server: the
 * agent would browse as a human identity outside its workspace, or drive a
 * browser it does not own. The adapter leaves the lane unset (Bladebro's
 * default is the isolated agent browser; only an explicit `real` selects
 * the human lane), never passes --host/--port, and never runs `rb`
 * commands. Unknown lane values fail closed. */
export function assertIsolatedDaemonConfig(config: { lane?: string }): void {
  const lane = (config.lane ?? "").trim().toLowerCase();
  if (lane === "") return;
  if (lane === "real") {
    throw new Error("blade real-browser lane is forbidden: it browses as a human identity");
  }
  throw new Error(`unknown blade lane "${config.lane ?? ""}": refusing to launch outside the isolated workspace`);
}
