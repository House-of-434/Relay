import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { commandReceipt } from "./commands.ts";
import { DATA_DIR } from "./config.ts";
import {
  createMailReplyRow,
  drainRoutedReplies,
  type MailReplyRow,
} from "./mail-reply-outbox.ts";
import { closeMessageDb, mutateCommandReceipt } from "./message-db.ts";

const NOW = Date.now();

function create(overrides: Partial<Parameters<typeof createMailReplyRow>[0]> = {}) {
  createMailReplyRow({
    turnId: "turn-1",
    threadId: "relay-thread",
    gmailThreadId: "gmail-thread",
    sourceMessageId: "source-message",
    to: "bob@houseof434.com",
    subject: "Re: Pitch",
    body: "Here is the answer.",
    messageId: "<relay-turn-1@houseof434.com>",
    attachments: [],
    ...overrides,
  });
}

function row(turnId = "turn-1"): MailReplyRow {
  return commandReceipt<MailReplyRow>("gmail.reply", turnId)!.result;
}

function setRow(turnId: string, update: (current: MailReplyRow) => MailReplyRow): void {
  mutateCommandReceipt("gmail.reply", turnId, (rows) => {
    const stored = rows.find((entry) => entry.kind === "gmail.reply" && entry.key === turnId);
    if (!stored) return null;
    return JSON.stringify(update(JSON.parse(stored.result) as MailReplyRow));
  }, NOW);
}

const sent = () => ({ sentId: "sent-1", gmailThreadId: "gmail-thread" });

describe("routed reply outbox", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("creates one pending row per turn", () => {
    create();
    create();
    expect(row().state).toBe("pending");
    expect(row().attempts).toBe(0);
    expect(commandReceipt("gmail.reply", "turn-1")).not.toBeNull();
  });

  it("sends one pending row once and marks it sent", async () => {
    create();
    let sends = 0;
    const deps = {
      send: async () => { sends += 1; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    };
    await drainRoutedReplies(deps);
    expect(sends).toBe(1);
    expect(row().state).toBe("sent");
    expect(row().sentId).toBe("sent-1");
    await drainRoutedReplies(deps);
    expect(sends).toBe(1);
  });

  it("lets only one concurrent drain claim a row", async () => {
    create();
    let sends = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = {
      send: async () => { sends += 1; await gate; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    };
    const first = drainRoutedReplies(deps);
    const second = drainRoutedReplies(deps);
    release();
    await Promise.all([first, second]);
    expect(sends).toBe(1);
    expect(row().state).toBe("sent");
  });

  it("reconciles a stale sending row by Message-ID instead of resending", async () => {
    create();
    setRow("turn-1", (current) => ({
      ...current,
      state: "sending",
      claimId: "old-claim",
      leaseUntil: NOW - 1,
      attempts: 1,
      reconcile: true,
    }));
    let sends = 0;
    await drainRoutedReplies({
      send: async () => { sends += 1; return sent(); },
      findSent: async (messageId) => messageId === "<relay-turn-1@houseof434.com>",
      log: () => {},
      now: () => NOW,
    });
    expect(sends).toBe(0);
    expect(row().state).toBe("sent");
  });

  it("moves a definitive 4xx refusal to dead", async () => {
    create();
    const logs: Array<Record<string, unknown>> = [];
    await drainRoutedReplies({
      send: async () => { throw Object.assign(new Error("invalid thread"), { status: 400 }); },
      findSent: async () => false,
      log: (event) => logs.push(event),
      now: () => NOW,
    });
    expect(row().state).toBe("dead");
    expect(logs.some((event) => event.event === "mail-reply.dead")).toBe(true);
  });

  it("does not send a later reply while an earlier one in the conversation is failed", async () => {
    create({ turnId: "turn-1" });
    create({ turnId: "turn-2", messageId: "<relay-turn-2@houseof434.com>" });
    setRow("turn-1", (current) => ({ ...current, createdAt: 1 }));
    setRow("turn-2", (current) => ({ ...current, createdAt: 2 }));
    const sentTurns: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    await drainRoutedReplies({
      send: async (input) => {
        sentTurns.push(input.messageId);
        throw Object.assign(new Error("provider unavailable"), { status: 503 });
      },
      findSent: async () => false,
      log: (event) => logs.push(event),
      now: () => NOW,
    });
    expect(sentTurns).toEqual(["<relay-turn-1@houseof434.com>"]);
    expect(row("turn-1").state).toBe("failed");
    expect(row("turn-2").state).toBe("pending");
  });

  it("retries a missing attachment before sending the text without it", async () => {
    create({
      attachments: [{ path: "/definitely/not/here/report.pdf", filename: "report.pdf", mimeType: "application/pdf" }],
    });
    let sends = 0;
    await drainRoutedReplies({
      send: async () => { sends += 1; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(sends).toBe(0);
    expect(row().state).toBe("failed");
    expect(row().attempts).toBe(1);
  });
});
