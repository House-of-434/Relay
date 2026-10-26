/** Atomic parent reservation for a routed email conversation.
 *
 * The command receipt's unique (kind, key) is the claim; the deterministic
 * thread id makes task creation idempotent, so a crash between creating the
 * task and writing the receipt converges on the same parent instead of
 * opening a second thread. The sender check keeps one mailbox conversation
 * from leaking into another person's parent. */
import { runCommand } from "./commands.ts";
import {
  RoutedMailParentError,
  routedMailThreadId,
  type MailboxMessage,
  type MailboxPerson,
} from "./mailbox-monitor.ts";
import type { Store } from "./store.ts";

export interface ReserveRoutedThreadInput {
  store: Store;
  /** Supabase user id owning Relay's shared mailbox connection. */
  mailboxAccount: string;
  workBotId: string;
  title: string;
  inbound: MailboxMessage;
  sender: MailboxPerson;
  routedSubject?: string;
}

export function reserveRoutedThread(input: ReserveRoutedThreadInput): string {
  const gmailThreadId = input.inbound.threadId?.trim() || input.inbound.id;
  const key = `${input.mailboxAccount}:${gmailThreadId}`;
  const deterministicThreadId = routedMailThreadId(input.mailboxAccount, gmailThreadId);
  const routed = {
    userId: input.sender.userId,
    email: input.sender.email,
    messageId: input.inbound.id,
    gmailThreadId,
    ...(input.routedSubject ? { subject: input.routedSubject } : {}),
  };

  const { threadId } = runCommand<{ threadId: string }>({ kind: "gmail.thread", key }, () => {
    const existing = input.store.taskByThread(input.workBotId, deterministicThreadId);
    if (existing) {
      const current = existing.mailRouted;
      if (!current) {
        input.store.patchTask(input.workBotId, existing.threadId, { mailRouted: routed });
      } else {
        if (current.userId !== input.sender.userId ||
            current.email.trim().toLowerCase() !== input.sender.email.trim().toLowerCase()) {
          throw new RoutedMailParentError("different-sender");
        }
        // The conversation keeps its original subject and sender; only the
        // latest inbound id advances for fallback threading.
        input.store.patchTask(input.workBotId, existing.threadId, {
          mailRouted: { ...current, messageId: input.inbound.id },
        });
      }
      return { threadId: existing.threadId };
    }
    const task = input.store.createTask(
      input.workBotId,
      input.title,
      false,
      undefined,
      undefined,
      undefined,
      deterministicThreadId,
    );
    if (!task) throw new Error("could not open the routed conversation");
    input.store.patchTask(input.workBotId, task.threadId, { mailRouted: routed });
    return { threadId: task.threadId };
  });

  const task = input.store.taskByThread(input.workBotId, threadId);
  const current = task?.mailRouted;
  if (!task || !current) throw new RoutedMailParentError("missing-parent");
  if (current.userId !== input.sender.userId ||
      current.email.trim().toLowerCase() !== input.sender.email.trim().toLowerCase()) {
    throw new RoutedMailParentError("different-sender");
  }
  // A replay returns the stored receipt without running the command body, so
  // the mutable "latest inbound" pointer advances outside the claim. It is
  // idempotent and never changes the parent's sender or subject.
  if (current.messageId !== input.inbound.id) {
    input.store.patchTask(input.workBotId, threadId, {
      mailRouted: { ...current, messageId: input.inbound.id },
    });
  }
  return threadId;
}
