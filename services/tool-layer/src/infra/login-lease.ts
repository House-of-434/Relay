/** Cross-process reservation for a user's interactive browser.
 *
 * One session per user must hold beyond a single Tool Layer process, so the
 * reservation is a file in the user's workspace created with O_EXCL. The
 * holder writes a random token; release removes the file only when the token
 * still matches. A lease older than the hard cap is stale and reclaimed.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface InteractiveLease {
  release(): void;
}

interface LeaseRecord {
  token: string;
  startedAt: number;
  pid: number;
}

/** Live holder check. A lease left by a dead process is reclaimable
 * immediately; a stale age is the fallback for an unreadable/foreign pid. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export function interactiveLeasePath(dataRoot: string, userId: string): string {
  return join(dataRoot, userId, ".interactive-session.lock");
}

export function acquireInteractiveLease(options: {
  dataRoot: string;
  userId: string;
  maxLifetimeMs: number;
  now?: () => number;
}): InteractiveLease | null {
  const now = options.now ?? Date.now;
  const path = interactiveLeasePath(options.dataRoot, options.userId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const record: LeaseRecord = { token, startedAt: now(), pid: process.pid };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      return {
        release: () => {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>;
            if (current.token === token) unlinkSync(path);
          } catch {
            /* already released or reclaimed */
          }
        },
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "EEXIST") throw error;
      let stale = true;
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>;
        const ownerAlive = typeof current.pid === "number" && pidAlive(current.pid);
        stale = !ownerAlive
          || typeof current.startedAt !== "number"
          || now() - current.startedAt >= options.maxLifetimeMs;
      } catch {
        // An unreadable lease cannot be trusted; reclaim it.
        stale = true;
      }
      if (!stale) return null;
      try {
        unlinkSync(path);
      } catch {
        /* another process won the reclaim */
      }
    }
  }
  return null;
}
