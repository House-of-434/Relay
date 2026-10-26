import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { commandReceipt } from "./commands.ts";
import { DATA_DIR } from "./config.ts";
import {
  createMailReplyRow,
  drainRoutedReplies,
  shouldMirrorRoutedTurn,
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
  it("mirrors only an eligible routed turn inside the unattended window", () => {
    expect(shouldMirrorRoutedTurn({ mailRouted: true, ok: true, completedTurnId: "turn-1", unattended: true })).toBe(true);
    expect(shouldMirrorRoutedTurn({ mailRouted: true, ok: true, completedTurnId: "turn-1", unattended: false })).toBe(false);
    expect(shouldMirrorRoutedTurn({ mailRouted: true, ok: false, completedTurnId: "turn-1", unattended: true })).toBe(false);
    expect(shouldMirrorRoutedTurn({ mailRouted: true, ok: true, completedTurnId: undefined, unattended: true })).toBe(false);
    expect(shouldMirrorRoutedTurn({ mailRouted: false, ok: true, completedTurnId: "turn-1", unattended: true })).toBe(false);
  });

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

  it("sends a missing attachment's reply immediately with a note instead of retrying", async () => {
    create({
      attachments: [{ path: "/definitely/not/here/report.pdf", filename: "report.pdf", mimeType: "application/pdf" }],
    });
    let sends = 0;
    let seenBody = "";
    await drainRoutedReplies({
      send: async (input) => { sends += 1; seenBody = input.body; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(sends).toBe(1);
    expect(seenBody).toContain("report.pdf");
    expect(row().state).toBe("sent");
  });

  it("discloses settle-time omissions in both the text and HTML alternatives", async () => {
    create({
      html: "<div><p>Here is the answer.</p></div>",
      omittedAttachments: ["big-report.pdf"],
    });
    let seenBody = "";
    let seenHtml: string | undefined;
    await drainRoutedReplies({
      send: async (input) => { seenBody = input.body; seenHtml = input.html; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(row().state).toBe("sent");
    expect(seenBody).toContain("big-report.pdf");
    expect(seenHtml).toContain("big-report.pdf");
  });

  it("sends an oversized attachment's reply immediately without blocking a later reply", async () => {
    const big = join(DATA_DIR, "big-report.pdf");
    writeFileSync(big, Buffer.alloc(21 * 1024 * 1024, 1));
    create({
      turnId: "turn-1",
      messageId: "<relay-turn-1@houseof434.com>",
      attachments: [{ path: big, filename: "big-report.pdf", mimeType: "application/pdf" }],
    });
    create({ turnId: "turn-2", messageId: "<relay-turn-2@houseof434.com>" });
    setRow("turn-1", (current) => ({ ...current, createdAt: 1 }));
    setRow("turn-2", (current) => ({ ...current, createdAt: 2 }));
    const bodies: string[] = [];
    const sentTurns: string[] = [];
    let attachmentsSeen: number[] = [];
    await drainRoutedReplies({
      send: async (input) => {
        sentTurns.push(input.messageId);
        bodies.push(input.body);
        attachmentsSeen.push(input.attachments.length);
        return sent();
      },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(sentTurns).toEqual(["<relay-turn-1@houseof434.com>", "<relay-turn-2@houseof434.com>"]);
    expect(attachmentsSeen).toEqual([0, 0]);
    expect(bodies[0]).toContain("Here is the answer.");
    expect(bodies[0]).toContain("big-report.pdf");
    expect(row("turn-1").state).toBe("sent");
    expect(row("turn-2").state).toBe("sent");
  });

  it("sends a prohibited attachment's reply body instead of killing the reply", async () => {
    const script = join(DATA_DIR, "report.js");
    writeFileSync(script, "console.log('report');\n");
    create({
      attachments: [{ path: script, filename: "report.js", mimeType: "application/javascript" }],
    });
    let sends = 0;
    let seenAttachments = -1;
    let seenBody = "";
    await drainRoutedReplies({
      send: async (input) => {
        sends += 1;
        seenAttachments = input.attachments.length;
        seenBody = input.body;
        return sent();
      },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(sends).toBe(1);
    expect(seenAttachments).toBe(0);
    expect(seenBody).toContain("Here is the answer.");
    expect(seenBody).toContain("report.js");
    expect(row().state).toBe("sent");
  });

  it("dead-ends a permanently skipped send immediately with skipped and dead logs", async () => {
    create();
    const logs: Array<Record<string, unknown>> = [];
    let sends = 0;
    await drainRoutedReplies({
      send: async () => {
        sends += 1;
        return { skipped: true as const, reason: "mailbox notifications disabled", permanent: true };
      },
      findSent: async () => false,
      log: (event) => logs.push(event),
      now: () => NOW,
    });
    expect(sends).toBe(1);
    expect(row().state).toBe("dead");
    expect(row().attempts).toBe(1);
    const skipped = logs.find((event) => event.event === "mail-reply.skipped");
    expect(skipped?.turnId).toBe("turn-1");
    const dead = logs.find((event) => event.event === "mail-reply.dead");
    expect(dead?.turnId).toBe("turn-1");
    expect(dead?.attempts).toBe(1);
    expect(JSON.stringify(logs)).not.toContain("Here is the answer.");
  });

  it("retries a transiently skipped send and logs dead on exhaustion", async () => {
    create();
    const logs: Array<Record<string, unknown>> = [];
    let now = NOW;
    const deps = {
      send: async () => null,
      findSent: async () => false,
      log: (event: Record<string, unknown>) => logs.push(event),
      now: () => now,
    };
    await drainRoutedReplies(deps);
    expect(row().state).toBe("failed");
    expect(logs.some((event) => event.event === "mail-reply.skipped")).toBe(true);
    expect(logs.some((event) => event.event === "mail-reply.dead")).toBe(false);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      now += 61 * 60_000;
      await drainRoutedReplies(deps);
    }
    expect(row().state).toBe("dead");
    expect(row().attempts).toBe(5);
    const dead = logs.find((event) => event.event === "mail-reply.dead");
    expect(dead?.turnId).toBe("turn-1");
    expect(dead?.attempts).toBe(5);
  });

  it("persists the HTML alternative across a retry", async () => {
    create({ html: "<div><p>Here is the answer.</p></div>" });
    const seen: Array<string | undefined> = [];
    let now = NOW;
    let attempt = 0;
    const deps = {
      send: async (input: { html?: string }) => {
        seen.push(input.html);
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error("temporary"), { status: 503 });
        return sent();
      },
      findSent: async () => false,
      log: () => {},
      now: () => now,
    };
    await drainRoutedReplies(deps);
    expect(row().state).toBe("failed");
    now += 61 * 60_000;
    await drainRoutedReplies(deps);
    expect(row().state).toBe("sent");
    expect(seen).toEqual([
      "<div><p>Here is the answer.</p></div>",
      "<div><p>Here is the answer.</p></div>",
    ]);
  });

  it("sends a long body without truncating it", async () => {
    const body = "x".repeat(30_000);
    create({ body });
    let seen = "";
    await drainRoutedReplies({
      send: async (input) => { seen = input.body; return sent(); },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(row().state).toBe("sent");
    expect(seen).toBe(body);
    expect(seen).not.toContain("truncated by Relay");
  });

  it("drops a BFF-rejectable attachment with a note instead of dead-lettering", async () => {
    const file = join(DATA_DIR, "notes.txt");
    writeFileSync(file, "hello");
    create({
      attachments: [{ path: file, filename: "notes.txt", mimeType: "text/plain; charset=utf-8" }],
      html: "<div><p>Here is the answer.</p></div>",
    });
    let seen: { attachments: unknown[]; body: string; html?: string } | undefined;
    await drainRoutedReplies({
      send: async (input) => {
        seen = input;
        return sent();
      },
      findSent: async () => false,
      log: () => {},
      now: () => NOW,
    });
    expect(row().state).toBe("sent");
    expect(seen?.attachments).toEqual([]);
    expect(seen?.body).toContain("notes.txt");
    expect(seen?.html).toContain("notes.txt");
  });

  it("dead-letters an oversized reply on a permanent 413", async () => {
    create({ body: "x".repeat(300_000) });
    const logs: Array<Record<string, unknown>> = [];
    await drainRoutedReplies({
      send: async () => {
        throw Object.assign(new Error("reply body is 300000 bytes; the limit is 256000"), { status: 413 });
      },
      findSent: async () => false,
      log: (event) => logs.push(event),
      now: () => NOW,
    });
    expect(row().state).toBe("dead");
    expect(row().attempts).toBe(1);
    const dead = logs.find((event) => event.event === "mail-reply.dead");
    expect(dead?.error).toContain("the limit is 256000");
  });
});
