// The guided tour's step record, in the browser, for a session that cannot
// write the workspace's onboarding record. `PUT /api/config` is admin-only, so
// a member of Relay's shared workspace signs in with client scope and every
// save is refused. The tour is purely client-side behaviour, so it must still
// be usable: server persistence when the session can write, this when it
// cannot.
//
// The welcome flow already keeps its one-time state this way, in the same
// storage and under the same rule (`emailGateDone` in lib/analytics). This is
// the next piece of first-run state to need it, not a second identity system:
// there is no account here, no key per user, and nothing that decides who
// somebody is. A second browser is a first visit again, which is the truth of
// a record this browser never sent anywhere.

import { SPOTLIGHTS } from "./first-conversation";
import { TOUR_STEPS } from "./guided-tour";

const TOUR_SEEN_KEY = "relay-guided-tour-seen";

/** What the tour needs from `localStorage`. Narrow on purpose: the tests
 * pass a plain object, and nothing else is required of the real thing. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Null when storage is unavailable (a private window, or blocked cookies),
 * so every caller here stays a no-op rather than throwing. */
export function tourStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    return storage ? (storage as StorageLike) : null;
  } catch {
    // Reading the property itself throws when cookies are blocked.
    return null;
  }
}

/** The ids this storage may hold: the tour's steps and the first-conversation
 * spotlights. Membership, not a shape check — a well-formed id from a build
 * that no longer has that step is dropped rather than kept forever. */
function knownHintIds(): ReadonlySet<string> {
  return new Set([...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS]);
}

/** Steps this browser has already been shown. Anything unrecognised is
 * dropped: the list is written from ids this app generates, so a value that
 * names no live step is stale or hand-edited, and keeping it would grow the
 * list without bound. */
export function readTourSeen(storage: StorageLike | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(TOUR_SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = knownHintIds();
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && known.has(id as never)))];
  } catch {
    return [];
  }
}

/** Remember one step. Returns the full list, so the caller can keep using the
 * value it just wrote instead of reading the storage back. A no-op returns
 * the list unchanged. */
export function writeTourSeen(storage: StorageLike | null, id: string): string[] {
  const seen = readTourSeen(storage);
  if (seen.includes(id)) return seen;
  const next = [...seen, id];
  try {
    storage?.setItem(TOUR_SEEN_KEY, JSON.stringify(next));
  } catch {
    // Storage that throws on write (private window, quota) must not break the
    // tour: the step still advances, and the worst case is a replay.
  }
  return next;
}

/** Forget every tour step, for Settings → Replay app tour. */
export function clearTourSeen(storage: StorageLike | null): void {
  try {
    storage?.removeItem(TOUR_SEEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Whether the tour has nothing left to show, from the browser's record. */
export function tourSeenComplete(storage: StorageLike | null, steps: readonly string[]): boolean {
  const seen = readTourSeen(storage);
  return steps.every((id) => seen.includes(id));
}
