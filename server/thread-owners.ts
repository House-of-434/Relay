// Server-owned thread→user ownership. The single source of truth for "whose
// thread is this" once real users share a deployment.
//
// Written ONLY from verified session identity at send time (auth.session
// .userId), never from model input, patches, backups, or imports. A forged
// owner would route another user's browser workspace and routine runs, so
// the write path validates the user id as a UUID and fails closed.
//
// First-writer-wins: the verified sender of a thread's first send owns it.
// Later sends never overwrite — a second user messaging into a thread cannot
// steal it. Threads with no verified sender (loopback/desktop, unattended
// routine runs) simply have no entry, and callers fall back to their existing
// derivation (transcript scan, routine owner).
//
// Persistence is one small JSON file per data dir, written synchronously and
// only when a genuinely new owner is recorded (once per thread). Same 0600
// discipline as the decision log: user ids are identity data.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isUuidUserId } from "./sessions.ts";

export interface ThreadOwner {
  userId: string;
  /** Verified session email at record time, when the sender carried one. */
  email?: string;
  at: number;
}

const FILE_NAME = "thread-owners.json";

const caches = new Map<string, Map<string, ThreadOwner>>();

function load(dataDir: string): Map<string, ThreadOwner> {
  const cached = caches.get(dataDir);
  if (cached) return cached;
  const owners = new Map<string, ThreadOwner>();
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE_NAME), "utf8")) as Record<string, unknown>;
    if (raw && typeof raw === "object") {
      for (const [threadId, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const row = value as { userId?: unknown; email?: unknown; at?: unknown };
        // Corrupt or foreign rows are skipped, never trusted: the file is
        // server-written, but a hand-edited or partially-written file must
        // not mint ownership.
        if (!isUuidUserId(typeof row.userId === "string" ? row.userId : undefined)) continue;
        owners.set(threadId, {
          userId: row.userId as string,
          ...(typeof row.email === "string" && row.email ? { email: row.email } : {}),
          at: typeof row.at === "number" ? row.at : 0,
        });
      }
    }
  } catch {
    // Missing or unreadable file means no known owners, not a failure.
  }
  caches.set(dataDir, owners);
  return owners;
}

function persist(dataDir: string, owners: Map<string, ThreadOwner>): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, FILE_NAME),
      JSON.stringify(Object.fromEntries(owners), null, 2),
      { mode: 0o600 },
    );
  } catch {
    // Ownership logging must never fail a send. The in-memory record stands
    // for this process; the next record retries the write.
  }
}

/** The recorded owner of a thread, if a verified sender ever stamped it. */
export function threadOwner(dataDir: string, threadId: string): ThreadOwner | undefined {
  return load(dataDir).get(threadId);
}

/**
 * Record the owner of a thread. Returns true when this call created the
 * record. First-writer-wins: an existing owner is never overwritten.
 * Rejects non-UUID user ids without recording.
 */
export function recordThreadOwner(
  dataDir: string,
  threadId: string,
  userId: string | undefined,
  email?: string,
): boolean {
  if (!threadId || !isUuidUserId(userId)) return false;
  const owners = load(dataDir);
  if (owners.has(threadId)) return false;
  owners.set(threadId, {
    userId,
    ...(typeof email === "string" && email ? { email } : {}),
    at: Date.now(),
  });
  persist(dataDir, owners);
  return true;
}

/**
 * Inherit a parent thread's recorded owner onto a newly created child.
 * Returns true when the child was stamped. A parent with no recorded owner
 * leaves the child ownerless — never infer from the current session, and
 * never treat a missing owner as a signal of any kind.
 *
 * Called at thread-creation time, where the parent/child relationship is
 * authoritative — never as a lookup fallback. First-writer-wins still
 * applies defensively through recordThreadOwner.
 */
export function inheritThreadOwner(
  dataDir: string,
  parentThreadId: string,
  childThreadId: string,
): boolean {
  if (!parentThreadId || !childThreadId || parentThreadId === childThreadId) return false;
  const parent = threadOwner(dataDir, parentThreadId);
  if (!parent) return false;
  return recordThreadOwner(dataDir, childThreadId, parent.userId, parent.email);
}

/** Test seam: drop the cached map so the next call re-reads the file. */
export function clearThreadOwnerCache(dataDir?: string): void {
  if (dataDir === undefined) caches.clear();
  else caches.delete(dataDir);
}
