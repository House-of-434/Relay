import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveMailSubject, MAIL_SEND_CLAIM_TTL_MS, mailboxReplyNeedsNoEmail, mailboxReplySubject, mailSendClaimFresh, mailSendFingerprint, mailSendReceiptSent, markdownToPlainText, sendMailboxAcknowledgement, sendMailboxQuestionEmail, sendMailboxReply } from "./mailbox-notify.ts";
import type { MailboxActor } from "./mailbox-bff.ts";

const ACTOR: MailboxActor = {
  userId: "1457cb2a-7543-4b48-8854-a63cd160241f",
  botId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  threadId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  agent: "mercury",
};

describe("shared-mailbox completion notices", () => {
  it("skips the completion email for NO_ACTION replies, Markdown or not", () => {
    expect(mailboxReplyNeedsNoEmail("NO_ACTION")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("NO_ACTION: invite noted")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("**NO_ACTION**")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("no_action")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("I scheduled the reminder.")).toBe(false);
    expect(mailboxReplyNeedsNoEmail(undefined)).toBe(false);
  });
});

describe("markdown to plain text for the email body", () => {
  it("flattens emphasis so literal asterisks never leak", () => {
    expect(markdownToPlainText("**Top 5** trending and *fast*")).toBe("Top 5 trending and fast");
  });

  it("keeps link text with its target, and bullets for lists", () => {
    expect(markdownToPlainText("See [the doc](https://example.test/doc)")).toBe("See the doc (https://example.test/doc)");
    expect(markdownToPlainText("- one\n- two")).toBe("- one\n- two");
  });

  it("keeps code content, drops headings markers, and trims blank runs", () => {
    expect(markdownToPlainText("# Title\n\n`npm run x`")).toBe("Title\n\nnpm run x");
  });
});

describe("receipt subject from the request", () => {
  it("prefers the sender's subject and falls back to the request's first line", () => {
    expect(deriveMailSubject("Find the Anthropic post", "body")).toBe("Find the Anthropic post");
    expect(deriveMailSubject("   ", "What is the CEO of Nvidia?\nmore")).toBe("What is the CEO of Nvidia?");
    // A leading "Subject:" typed by the sender does not leak into the subject.
    expect(deriveMailSubject(undefined, "Subject: Quarterly numbers")).toBe("Quarterly numbers");
    expect(deriveMailSubject(undefined, "   \n\n  ")).toBeUndefined();
    expect(deriveMailSubject(undefined, undefined)).toBeUndefined();
  });
});

describe("reply subject", () => {
  it("answers the sender's own line rather than claiming a finished task", () => {
    expect(mailboxReplySubject("Can you find the Anthropic post?")).toBe("Re: Can you find the Anthropic post?");
    // Already a reply: never stack prefixes.
    expect(mailboxReplySubject("Re: deck for Thursday")).toBe("Re: deck for Thursday");
    // No subject to answer: a plain line, not a status claim.
    expect(mailboxReplySubject(undefined)).toBe("Your Relay request");
    expect(mailboxReplySubject("   ")).toBe("Your Relay request");
    expect(mailboxReplySubject("x".repeat(400)).length).toBe(250);
  });
});

describe("receipt acknowledgement", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.address = process.env.RELAY_MAILBOX_ADDRESS;
    saved.userId = process.env.RELAY_MAILBOX_USER_ID;
    saved.secret = process.env.RELAY_TOOL_ACTOR_SECRET;
    process.env.RELAY_MAILBOX_ADDRESS = "relay@houseof434.com";
    process.env.RELAY_MAILBOX_USER_ID = ACTOR.userId;
    process.env.RELAY_TOOL_ACTOR_SECRET = "actor-secret-that-is-at-least-thirty-two-bytes";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({
      RELAY_MAILBOX_ADDRESS: saved.address,
      RELAY_MAILBOX_USER_ID: saved.userId,
      RELAY_TOOL_ACTOR_SECRET: saved.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("answers through the trusted reply route and says only that the mail arrived", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    await sendMailboxAcknowledgement({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      email: "friend@example.test",
      subject: "Find the post",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });

    const payload = JSON.parse(bodies[0]!) as {
      subject: string;
      body: string;
      mailbox?: string;
      to?: string[];
      gmailThreadId?: string;
      sourceMessageId?: string;
    };
    const headers = requests[0]!.init?.headers as Record<string, string>;
    expect(requests[0]!.url).toContain("/api/internal/gmail/reply");
    expect(headers["x-relay-mail-mirror"]).toBe(`Bearer ${"m".repeat(40)}`);
    expect(payload.mailbox).toBeUndefined();
    expect(payload.to).toEqual(["friend@example.test"]);
    expect(payload.gmailThreadId).toBe("gmail-thread");
    expect(payload.sourceMessageId).toBe("gmail-message");
    expect(payload.subject).toBe("Re: Find the post");
    expect(payload.body).toContain("received your email");
    // The receipt is not the result and must not claim one.
    expect(payload.body).not.toContain("finished");
  });
});

describe("completion email structure", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.address = process.env.RELAY_MAILBOX_ADDRESS;
    saved.userId = process.env.RELAY_MAILBOX_USER_ID;
    saved.secret = process.env.RELAY_TOOL_ACTOR_SECRET;
    process.env.RELAY_MAILBOX_ADDRESS = "relay@houseof434.com";
    process.env.RELAY_MAILBOX_USER_ID = ACTOR.userId;
    process.env.RELAY_TOOL_ACTOR_SECRET = "actor-secret-that-is-at-least-thirty-two-bytes";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({
      RELAY_MAILBOX_ADDRESS: saved.address,
      RELAY_MAILBOX_USER_ID: saved.userId,
      RELAY_TOOL_ACTOR_SECRET: saved.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  const capture = () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return bodies;
  };

  it("delivers an agent's question with its choices so an email sender can answer", async () => {
    const bodies = capture();
    await sendMailboxQuestionEmail({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      email: "friend@example.test",
      subject: "Update Social Gear",
      question: "Which company's page should I update?",
      choices: ["Social Gear", "A different company"],
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });
    const payload = JSON.parse(bodies[0]!) as { subject: string; body: string };
    expect(payload.subject).toBe("Re: Update Social Gear");
    expect(payload.body).toContain("Which company's page should I update?");
    expect(payload.body).toContain("- Social Gear");
    expect(payload.body).toContain("- A different company");
    expect(payload.body).toContain("Reply to this email with your answer.");
  });

  it("delivers every question and option of a two-question ask", async () => {
    const bodies = capture();
    await sendMailboxQuestionEmail({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      email: "friend@example.test",
      subject: "Update Social Gear",
      question: "Which model?\n- Opus\n- Sonnet\n\nWhich stores?\n- Instamart\n- Blinkit",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });
    const payload = JSON.parse(bodies[0]!) as { subject: string; body: string };
    expect(payload.body).toContain("Which model?");
    expect(payload.body).toContain("Which stores?");
    expect(payload.body).toContain("- Opus");
    expect(payload.body).toContain("- Sonnet");
    expect(payload.body).toContain("- Instamart");
    expect(payload.body).toContain("- Blinkit");
  });

  it("receipt and reply share one subject so the two emails thread", async () => {
    const bodies = capture();
    // One subject, derived once from the sender's request, used by both sends.
    const derived = deriveMailSubject("", "Find the latest Anthropic post");
    const subject = mailboxReplySubject(derived);
    await sendMailboxAcknowledgement({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      email: "friend@example.test",
      subject: derived,
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });
    await sendMailboxReply({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      to: "friend@example.test",
      subject,
      body: "Here it is.",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });
    const ackSubject = (JSON.parse(bodies[0]!) as { subject: string }).subject;
    const replySubject = (JSON.parse(bodies[1]!) as { subject: string }).subject;
    expect(ackSubject).toBe("Re: Find the latest Anthropic post");
    expect(replySubject).toBe(ackSubject);
  });

  it("sends the provided body as the reply", async () => {
    const bodies = capture();
    await sendMailboxReply({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      to: "friend@example.test",
      subject: "Re: Find the post",
      body: "Here is the link: https://example.test/post",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });
    const payload = JSON.parse(bodies[0]!) as { subject: string; body: string };
    expect(payload.subject).toBe("Re: Find the post");
    expect(payload.body).toContain("Here is the link: https://example.test/post");
    expect(payload.body).not.toContain("Open Relay");
  });
});

describe("completion email attachments", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.address = process.env.RELAY_MAILBOX_ADDRESS;
    saved.userId = process.env.RELAY_MAILBOX_USER_ID;
    saved.secret = process.env.RELAY_TOOL_ACTOR_SECRET;
    process.env.RELAY_MAILBOX_ADDRESS = "relay@houseof434.com";
    process.env.RELAY_MAILBOX_USER_ID = ACTOR.userId;
    process.env.RELAY_TOOL_ACTOR_SECRET = "actor-secret-that-is-at-least-thirty-two-bytes";
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({
      RELAY_MAILBOX_ADDRESS: saved.address,
      RELAY_MAILBOX_USER_ID: saved.userId,
      RELAY_TOOL_ACTOR_SECRET: saved.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("carries the turn's produced files so a report rides the reply", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    await sendMailboxReply({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      to: "friend@example.test",
      subject: "Re: Research",
      body: "Your deep research has finished.",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
      attachments: [{ filename: "report.md", mimeType: "text/markdown", data: "cmVwb3J0" }],
    });

    const payload = JSON.parse(bodies[0]!) as { mailbox?: string; attachments?: unknown };
    expect(payload.mailbox).toBeUndefined();
    expect(payload.attachments).toEqual([{ filename: "report.md", mimeType: "text/markdown", data: "cmVwb3J0" }]);
  });

  it("omits the attachments field entirely when the turn produced no files", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    await sendMailboxReply({
      capability: "x".repeat(40),
      mirrorCapability: "m".repeat(40),
      actor: ACTOR,
      to: "friend@example.test",
      subject: "Re: Question",
      body: "Here is the answer.",
      gmailThreadId: "gmail-thread",
      sourceMessageId: "gmail-message",
    });

    const payload = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect("attachments" in payload).toBe(false);
  });
});

describe("record-then-send receipts", () => {
  it("fingerprints the exact mail content, stable across calls", () => {
    const fp = mailSendFingerprint(["a@test", "Sub", "Body"]);
    expect(fp).toBe(mailSendFingerprint(["a@test", "Sub", "Body"]));
    expect(fp).not.toBe(mailSendFingerprint(["a@test", "Sub", "Other body"]));
    expect(fp).not.toBe(mailSendFingerprint(["b@test", "Sub", "Body"]));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats legacy bare-true receipts as sent", () => {
    expect(mailSendReceiptSent(true)).toBe(true);
    expect(mailSendReceiptSent({ state: "sent" })).toBe(true);
    expect(mailSendReceiptSent({ state: "claimed" })).toBe(false);
    expect(mailSendReceiptSent(undefined)).toBe(false);
    expect(mailSendReceiptSent(null)).toBe(false);
    expect(mailSendReceiptSent("sent")).toBe(false);
  });

  it("treats only unexpired claims as in-flight", () => {
    const now = 1_000_000;
    expect(mailSendClaimFresh({ state: "claimed", at: now - 1_000 }, now)).toBe(true);
    expect(mailSendClaimFresh({ state: "claimed", at: now - MAIL_SEND_CLAIM_TTL_MS }, now)).toBe(false);
    expect(mailSendClaimFresh({ state: "claimed", at: now - MAIL_SEND_CLAIM_TTL_MS - 1 }, now)).toBe(false);
    expect(mailSendClaimFresh({ state: "sent", at: now - 1_000 }, now)).toBe(false);
    expect(mailSendClaimFresh(true, now)).toBe(false);
    expect(mailSendClaimFresh(undefined, now)).toBe(false);
  });
});
