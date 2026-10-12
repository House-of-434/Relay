// Transport for the shared-mailbox features (server/mailbox-monitor.ts and
// server/mailbox-notify.ts). It posts to the BFF's internal Gmail routes,
// signing a fresh actor assertion for Relay's own account. The BFF capability
// is passed in by the harness, which holds it in memory only — never in
// process.env, which engine child processes inherit.
import { signedActorContext } from "./relay-mcp.ts";

export function mailboxBffBase(): string {
  return process.env.RELAY_BFF_INTERNAL_URL?.trim() || `http://127.0.0.1:${process.env.RELAY_BFF_PORT?.trim() || "8798"}`;
}

export async function mailboxBffCall<T>(capability: string | undefined, path: string, payload: unknown): Promise<T> {
  const address = process.env.RELAY_MAILBOX_ADDRESS?.trim();
  const userId = process.env.RELAY_MAILBOX_USER_ID?.trim();
  if (!address || !userId) throw new Error("Relay's shared mailbox is not configured");
  const assertion = signedActorContext({ userId, email: address }, process.env.RELAY_TOOL_ACTOR_SECRET);
  const response = await fetch(new URL(path, mailboxBffBase()), {
    method: "POST",
    redirect: "error",
    headers: {
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      "x-relay-actor-user": assertion,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string") detail = body.error.slice(0, 200);
    } catch {
      // status-only message is enough
    }
    throw new Error(`shared mailbox call failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return await response.json() as T;
}
