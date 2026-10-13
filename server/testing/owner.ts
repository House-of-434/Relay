// The one account a verification fixture signs in as.
//
// Per-user isolation means a request without a verified session sees nothing,
// so the fixture obtains its identity the way a hosted user does: a real
// session with a real user id, issued into the fixture's own session store
// before the server boots. Nothing here is read by production code; the gate
// has no test branch and no environment switch.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SessionRegistry, type Scope } from "../sessions.ts";

/** A stable Supabase-shaped UUID for the fixture owner. */
export const TEST_OWNER_USER_ID = "00000000-0000-4000-8000-0000000000aa";
export const TEST_OWNER_EMAIL = "owner@relay.test";
export const TEST_OWNER_SCOPES: readonly Scope[] = ["admin", "client"];
/** A fixed HMAC secret so a fixture's owner-signed actor assertions verify
 * in-process. Real deployments set RELAY_TOOL_ACTOR_SECRET. */
export const TEST_TOOL_ACTOR_SECRET = "verification-fixture-actor-secret-value-over-32-bytes";

/** Issue the fixture owner's session. Both start and verify treat this as an
 * ordinary account session, so every gate applies unchanged. */
export function issueTestOwnerSession(registry: SessionRegistry): { token: string; session: { id: string } } {
  return registry.issue({
    label: "Verification owner",
    email: TEST_OWNER_EMAIL,
    userId: TEST_OWNER_USER_ID,
    scopes: [...TEST_OWNER_SCOPES],
  });
}

/** For tests that boot `server/index.ts` themselves: merge the owner into the
 * fixture's sign-in list (so boot-time revalidation keeps the session) and
 * issue the owner's session into its session store. Call after the test has
 * written its own config (it is merged, not replaced) and before spawn. The
 * returned bearer is what the test's `api` helper sends. */
export function prepareOwnerSession(dataDir: string): string {
  const configPath = join(dataDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent or invalid: start from an empty config */
  }
  const signIn = (config.signIn ?? {}) as { admins?: unknown[]; members?: unknown[] };
  const admins = Array.isArray(signIn.admins) ? [...signIn.admins] : [];
  if (!admins.some((entry) => String(entry).toLowerCase() === TEST_OWNER_EMAIL)) admins.push(TEST_OWNER_EMAIL);
  writeFileSync(configPath, JSON.stringify({ ...config, signIn: { ...signIn, admins } }, null, 2));
  const registry = new SessionRegistry({ file: join(dataDir, "sessions.json"), emailScopes: () => [...TEST_OWNER_SCOPES] });
  try {
    return issueTestOwnerSession(registry).token;
  } finally {
    registry.close();
  }
}

/** Stamp the fixture owner on a record a test seeds by hand. Ownerless cases
 * pass `null` explicitly so "no session sees nothing" stays testable. */
export function ownerRecord<T extends object>(record: T, ownerUserId: string | null = TEST_OWNER_USER_ID): T & { ownerUserId?: string } {
  return ownerUserId === null ? { ...record } : { ...record, ownerUserId };
}

export function ownerRecords<T extends object>(records: readonly T[], ownerUserId: string | null = TEST_OWNER_USER_ID): Array<T & { ownerUserId?: string }> {
  return records.map((record) => ownerRecord(record, ownerUserId));
}

// ── fetch interception ─────────────────────────────────────────────────
// Existing fixture tests call `fetch(fixture.info.url + path, { headers:
// { origin: fixture.info.url } })`. Rather than edit every one, the fixture
// registers its URL and a fetch wrapper injects the owner bearer, so those
// calls become the signed-in user's. A request that sets `x-relay-test-anonymous`
// opts out (that header is stripped) and reaches the server with no credential.
const ownerTokens = new Map<string, string>();
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    const entry = url === undefined ? undefined : [...ownerTokens.entries()].find(([base]) => url.startsWith(base));
    if (entry === undefined) return realFetch(input as never, init);
    const [base, token] = entry;
    const headers = new Headers(init?.headers);
    // A request that names a different origin is testing cross-origin refusal,
    // not a signed-in read: leave it unauthenticated.
    const origin = headers.get("origin");
    const sameOrigin = origin === null || origin === new URL(base).origin;
    if (headers.has("x-relay-test-anonymous")) {
      headers.delete("x-relay-test-anonymous");
    } else if (sameOrigin && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return realFetch(input as never, { ...init, headers });
  }) as typeof fetch;
}

/** Register a fixture's URL so its own fetches act as the fixture owner. */
export function registerOwnerFetch(baseUrl: string, token: string): void {
  ensureInstalled();
  ownerTokens.set(baseUrl, token);
}

export function unregisterOwnerFetch(baseUrl: string): void {
  ownerTokens.delete(baseUrl);
}
