// Transport for the shared-mailbox features (server/mailbox-monitor.ts and
// server/mailbox-notify.ts). It posts to the BFF's internal Gmail routes,
// signing a fresh actor assertion for Relay's own account. The BFF capability
// is passed in by the harness, which holds it in memory only — never in
// process.env, which engine child processes inherit.
import { signedActorContext } from "./relay-mcp.ts";

export function mailboxBffBase(): string {
  return process.env.RELAY_BFF_INTERNAL_URL?.trim() || `http://127.0.0.1:${process.env.RELAY_BFF_PORT?.trim() || "8798"}`;
}

/** The identity a relay@-account BFF call signs as: Relay's own user with
 * one of its bots (Mercury) and that bot's standing thread. The BFF resolves
 * the "relay" mailbox from its own configured owner id; the actor only needs
 * to be a validly signed per-user identity. */
export interface MailboxActor {
  userId: string;
  botId: string;
  threadId: string;
  agent: "mercury";
}

export class MailboxBffError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MailboxBffError";
  }
}

export async function mailboxBffCall<T>(
  capability: string | undefined,
  path: string,
  payload: unknown,
  actor: MailboxActor,
  mirrorCapability?: string,
): Promise<T> {
  const assertion = signedActorContext(actor, process.env.RELAY_TOOL_ACTOR_SECRET);
  const response = await fetch(new URL(path, mailboxBffBase()), {
    method: "POST",
    redirect: "error",
    headers: {
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      ...(mirrorCapability ? { "x-relay-mail-mirror": `Bearer ${mirrorCapability}` } : {}),
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
    throw new MailboxBffError(response.status, `shared mailbox call failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return await response.json() as T;
}
