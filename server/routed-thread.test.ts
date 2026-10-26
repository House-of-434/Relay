import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { commandReceipt } from "./commands.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import {
  RoutedMailParentError,
  routedMailThreadId,
  type MailboxMessage,
  type MailboxPerson,
} from "./mailbox-monitor.ts";
import { reserveRoutedThread } from "./routed-thread.ts";
import { Store } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const person = (overrides: Partial<MailboxPerson> = {}): MailboxPerson => ({
  userId: "22222222-2222-4222-8222-222222222222",
  email: "bob@houseof434.com",
  name: "Bob",
  ...overrides,
});

const inbound = (overrides: Partial<MailboxMessage> = {}): MailboxMessage => ({
  id: "message-1",
  threadId: "gmail-thread-1",
  from: '"Bob" <bob@houseof434.com>',
  subject: "Pitch deck",
  body: "Please remind me about the pitch deck.",
  ...overrides,
});

function reserve(
  store: Store,
  botId: string,
  overrides: {
    mailboxAccount?: string;
    inbound?: MailboxMessage;
    sender?: MailboxPerson;
    routedSubject?: string;
  } = {},
) {
  return reserveRoutedThread({
    store,
    mailboxAccount: overrides.mailboxAccount ?? "mailbox-account",
    workBotId: botId,
    title: "Email from Bob",
    inbound: overrides.inbound ?? inbound(),
    sender: overrides.sender ?? person(),
    routedSubject: overrides.routedSubject ?? "Pitch deck",
  });
}

describe("routed parent reservation", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("reserves one parent per mailbox conversation and replays the receipt", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Mercury" });
    const first = reserve(store, bot.id);
    const second = reserve(store, bot.id);

    expect(second).toBe(first);
    expect(store.tasks(bot.id).filter((task) => task.threadId === first)).toHaveLength(1);
    expect(store.taskByThread(bot.id, first)?.mailRouted).toMatchObject({
      userId: person().userId,
      email: person().email,
      messageId: "message-1",
      gmailThreadId: "gmail-thread-1",
      subject: "Pitch deck",
    });
    expect(commandReceipt("gmail.thread", "mailbox-account:gmail-thread-1")?.result).toEqual({
      threadId: first,
    });
  });

  it("advances the latest message on a follow-up without changing the sender or subject", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Mercury" });
    const first = reserve(store, bot.id);
    const second = reserve(store, bot.id, {
      inbound: inbound({ id: "message-2", subject: "Re: Pitch deck" }),
    });

    expect(second).toBe(first);
    expect(store.tasks(bot.id).filter((task) => task.threadId === first)).toHaveLength(1);
    expect(store.taskByThread(bot.id, first)?.mailRouted).toMatchObject({
      userId: person().userId,
      email: person().email,
      messageId: "message-2",
      gmailThreadId: "gmail-thread-1",
      subject: "Pitch deck",
    });
  });

  it("reuses a task left by a crash before its receipt", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Mercury" });
    const deterministic = routedMailThreadId("mailbox-account", "gmail-thread-1");
    store.createTask(bot.id, "Crashed", false, undefined, undefined, undefined, deterministic);
    store.patchTask(bot.id, deterministic, {
      mailRouted: {
        userId: person().userId,
        email: person().email,
        messageId: "message-0",
        gmailThreadId: "gmail-thread-1",
        subject: "Pitch deck",
      },
    });

    const reserved = reserve(store, bot.id);

    expect(reserved).toBe(deterministic);
    expect(store.tasks(bot.id).filter((task) => task.threadId === deterministic)).toHaveLength(1);
    expect(store.taskByThread(bot.id, deterministic)?.mailRouted?.messageId).toBe("message-1");
    expect(commandReceipt("gmail.thread", "mailbox-account:gmail-thread-1")).not.toBeNull();
  });

  it("quarantines a different sender instead of opening or reusing their parent", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Mercury" });
    const first = reserve(store, bot.id);

    expect(() => reserve(store, bot.id, {
      sender: person({ userId: "33333333-3333-4333-8333-333333333333", email: "eve@houseof434.com" }),
    })).toThrow(RoutedMailParentError);

    expect(store.tasks(bot.id).filter((task) => task.threadId === first)).toHaveLength(1);
    expect(store.taskByThread(bot.id, first)?.mailRouted?.email).toBe(person().email);
  });

  it("scopes the same Gmail conversation to the mailbox account", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Mercury" });
    const first = reserve(store, bot.id, { mailboxAccount: "mailbox-a" });
    const second = reserve(store, bot.id, { mailboxAccount: "mailbox-b" });

    expect(second).not.toBe(first);
    expect(store.tasks(bot.id).filter((task) => task.threadId === first)).toHaveLength(1);
    expect(store.tasks(bot.id).filter((task) => task.threadId === second)).toHaveLength(1);
  });
});
