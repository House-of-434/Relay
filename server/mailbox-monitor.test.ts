import { describe, expect, it } from "vitest";

import {
  MAILBOX_HANDLE_LIMIT,
  MAILBOX_POLL_QUERY,
  MailboxMonitor,
  deliverRoutedMail,
  routedMailPrompt,
  routedMailTitle,
  senderAddress,
  type MailboxMessage,
  type MailboxMonitorDeps,
  type MailboxPerson,
  type RoutedMailDelivery,
} from "./mailbox-monitor.ts";

const USER_B = "22222222-2222-4222-8222-222222222222";
const SHARED = "relay@houseof434.com";
const BOB: MailboxPerson = { userId: USER_B, email: "bob@houseof434.com", name: "Bob" };

function message(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "message-1",
    from: `"Bob" <${BOB.email}>`,
    subject: "Pitch deck",
    date: "Mon, 5 Oct 2026 14:02:10 -0700",
    body: "Please remind me about the pitch deck Thursday morning.",
    ...overrides,
  };
}

describe("sender parsing", () => {
  it("extracts the addr-spec from a display-name header", () => {
    expect(senderAddress('"Bob Smith" <bob@houseof434.com>')).toBe("bob@houseof434.com");
    expect(senderAddress("BOB@HouseOf434.com")).toBe("bob@houseof434.com");
  });

  it("refuses headers that are not an address", () => {
    expect(senderAddress("Bob Smith")).toBeUndefined();
    expect(senderAddress(undefined)).toBeUndefined();
    expect(senderAddress("<not-an-address>")).toBeUndefined();
  });
});

describe("routed mail delivery", () => {
  it("queues B's mail on B's own thread with B's sender when the bot is busy with A", async () => {
    const queued: RoutedMailDelivery[] = [];
    const ran: RoutedMailDelivery[] = [];
    await deliverRoutedMail({
      botId: "mercury",
      threadFor: async () => "thread-b",
      // Bot X is mid-turn on A's thread and at capacity.
      isBlocked: () => true,
      queue: (delivery) => queued.push(delivery),
      run: async (delivery) => { ran.push(delivery); },
    }, {
      message: message(),
      person: BOB,
      personKey: "p_bob",
      text: "mail text",
      prompt: "mail prompt",
    });

    expect(ran).toEqual([]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.threadId).toBe("thread-b");
    expect(queued[0]!.sender).toMatchObject({
      actorUserId: USER_B,
      email: BOB.email,
      id: "p_bob",
      name: "Bob",
    });
  });

  it("runs on the routed thread when a slot is free", async () => {
    const queued: RoutedMailDelivery[] = [];
    const ran: RoutedMailDelivery[] = [];
    await deliverRoutedMail({
      botId: "mercury",
      threadFor: async () => "thread-b",
      isBlocked: () => false,
      queue: (delivery) => queued.push(delivery),
      run: async (delivery) => { ran.push(delivery); },
    }, { message: message(), person: BOB, personKey: "p_bob", text: "t", prompt: "p" });

    expect(queued).toEqual([]);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.threadId).toBe("thread-b");
    expect(ran[0]!.sender.actorUserId).toBe(USER_B);
  });

  it("falls back to the queue when the start races a capacity refusal", async () => {
    const queued: RoutedMailDelivery[] = [];
    await deliverRoutedMail({
      botId: "mercury",
      threadFor: async () => "thread-b",
      isBlocked: () => false,
      queue: (delivery) => queued.push(delivery),
      run: async () => { throw Object.assign(new Error("at the limit"), { code: "thread_limit" }); },
      isAdmissionBlocked: (error) => (error as { code?: string }).code === "thread_limit",
    }, {
      message: message(),
      person: BOB,
      personKey: "p_bob",
      text: "t",
      prompt: "p",
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.threadId).toBe("thread-b");
    expect(queued[0]!.sender.actorUserId).toBe(USER_B);
  });
});

describe("mailbox monitor ticks", () => {
  interface TickState {
    receipts: Map<string, unknown>;
    deliveries: Array<{ id: string; person: MailboxPerson }>;
    logs: Array<Record<string, unknown>>;
    reads: string[];
    messages: Map<string, MailboxMessage>;
    people: Map<string, MailboxPerson>;
    summaries: Array<{ id: string }>;
    readFails: Set<string>;
  }

  function state(): TickState {
    return {
      receipts: new Map(),
      deliveries: [],
      logs: [],
      reads: [],
      messages: new Map(),
      people: new Map(),
      summaries: [],
      readFails: new Set(),
    };
  }

  function monitorFor(config: TickState, overrides: Partial<MailboxMonitorDeps> = {}): MailboxMonitor {
    return new MailboxMonitor({
      address: SHARED,
      list: async () => config.summaries,
      read: async (id) => {
        config.reads.push(id);
        if (config.readFails.has(id)) throw new Error("read failed");
        return config.messages.get(id);
      },
      lookupPerson: (email) => config.people.get(email),
      hasReceipt: (kind, key) => config.receipts.has(`${kind}:${key}`),
      recordReceipt: async (kind, key, detail) => { config.receipts.set(`${kind}:${key}`, detail); },
      deliver: async (mailboxMessage, person) => {
        config.deliveries.push({ id: mailboxMessage.id, person });
      },
      log: (event) => { config.logs.push(event); },
      ...overrides,
    });
  }

  it("routes a known sender once and receipts the message", async () => {
    const config = state();
    config.summaries = [{ id: "m1" }];
    config.messages.set("m1", message({ id: "m1" }));
    config.people.set(BOB.email, BOB);
    await monitorFor(config).tick();

    expect(config.deliveries).toEqual([{ id: "m1", person: BOB }]);
    expect(config.receipts.get("gmail.route:m1")).toEqual({ routed: BOB.email });
  });

  it("skips receipted ids cheaply, without reading them", async () => {
    const config = state();
    config.summaries = [{ id: "m1" }, { id: "m2" }];
    config.receipts.set("gmail.route:m1", { routed: BOB.email });
    config.messages.set("m2", message({ id: "m2" }));
    config.people.set(BOB.email, BOB);
    await monitorFor(config).tick();

    expect(config.reads).toEqual(["m2"]);
    expect(config.deliveries.map((delivery) => delivery.id)).toEqual(["m2"]);
  });

  it("ignores unknown and self senders, receipts them, and counts them visibly", async () => {
    const config = state();
    config.summaries = [{ id: "m1" }, { id: "m2" }];
    config.messages.set("m1", message({ id: "m1", from: "stranger@example.test" }));
    config.messages.set("m2", message({ id: "m2", from: SHARED }));
    await monitorFor(config).tick();

    expect(config.deliveries).toEqual([]);
    expect(config.receipts.get("gmail.route:m1")).toEqual({ ignored: "unknown-sender" });
    expect(config.receipts.get("gmail.route:m2")).toEqual({ ignored: "self" });
    expect(config.logs).toContainEqual({ event: "mailbox.ignored-senders", tick: 2, total: 2 });
  });

  it("leaves no receipt when a read fails, so the next tick retries", async () => {
    const config = state();
    config.summaries = [{ id: "m1" }];
    config.readFails.add("m1");
    const monitor = monitorFor(config);
    await monitor.tick();
    expect(config.receipts.has("gmail.route:m1")).toBe(false);

    config.readFails.delete("m1");
    config.messages.set("m1", message({ id: "m1" }));
    config.people.set(BOB.email, BOB);
    await monitor.tick();
    expect(config.deliveries.map((delivery) => delivery.id)).toEqual(["m1"]);
  });

  it(`caps handling at ${MAILBOX_HANDLE_LIMIT} new messages per tick and leaves the rest for the next`, async () => {
    const config = state();
    for (let index = 0; index < MAILBOX_HANDLE_LIMIT + 2; index += 1) {
      const id = `m${index}`;
      config.summaries.push({ id });
      config.messages.set(id, message({ id }));
    }
    config.people.set(BOB.email, BOB);
    const monitor = monitorFor(config);
    await monitor.tick();
    expect(config.deliveries).toHaveLength(MAILBOX_HANDLE_LIMIT);

    await monitor.tick();
    expect(config.deliveries).toHaveLength(MAILBOX_HANDLE_LIMIT + 2);
    expect(config.deliveries.map((delivery) => delivery.id)).toEqual(
      Array.from({ length: MAILBOX_HANDLE_LIMIT + 2 }, (_, index) => `m${index}`),
    );
  });

  it("aborts the tick when the receipt store is unavailable", async () => {
    const config = state();
    config.summaries = [{ id: "m1" }];
    config.messages.set("m1", message({ id: "m1" }));
    config.people.set(BOB.email, BOB);
    const monitor = monitorFor(config, {
      hasReceipt: () => { throw new Error("database is down"); },
    });
    await monitor.tick();
    expect(config.deliveries).toEqual([]);
    expect(config.logs.some((entry) => entry.event === "mailbox.receipts-unavailable")).toBe(true);
  });
});

describe("routed mail prompt", () => {
  it("uses the plain mail query constant with no invite/category exclusions", () => {
    expect(MAILBOX_POLL_QUERY).toBe("in:inbox is:unread newer_than:1d");
  });

  it("frames the message as untrusted and asks for a readable result", () => {
    const prompt = routedMailPrompt(message(), BOB, { scribeEnabled: false });
    expect(prompt).toContain("UNTRUSTED EMAIL DATA");
    expect(prompt).toContain(BOB.email);
    expect(prompt).toContain("delegate to Scout");
    // Invitations must be acknowledged with NO_ACTION even before Scribe ships.
    expect(prompt).toContain("NO_ACTION");
    expect(prompt).not.toContain("Scribe attends");
    expect(prompt).not.toContain("meeting transcribed");
  });

  it("gates only the Scribe claim, not the invitation no-action rule", () => {
    const on = routedMailPrompt(message(), BOB, { scribeEnabled: true });
    expect(on).toContain("Scribe attends");
    expect(on).toContain("meeting transcribed");
    expect(on).toContain("NO_ACTION");
    const off = routedMailPrompt(message(), BOB, { scribeEnabled: false });
    expect(off).toContain("NO_ACTION");
    expect(off).not.toContain("Scribe attends");
  });

  it("lists attachments so the reader can identify them, without a type-specific rule", () => {
    const prompt = routedMailPrompt(message({
      attachments: [{ filename: "deck.pdf", mimeType: "application/pdf", size: 12_345 }],
    }), BOB, { scribeEnabled: false });
    expect(prompt).toContain("- deck.pdf (application/pdf, 12345 bytes)");
    // No claim that attachments are unreadable, and no hardcoded workflow.
    expect(prompt).not.toContain("I can't open attachments yet");
    expect(prompt).not.toContain("Dealflow");
  });

  it("leaves a message without attachments free of attachment talk", () => {
    const prompt = routedMailPrompt(message(), BOB, { scribeEnabled: false });
    expect(prompt).not.toContain("Attachments:");
  });

  it("titles threads from the subject, bounded to one line", () => {
    expect(routedMailTitle(message(), BOB)).toBe("Pitch deck");
    expect(routedMailTitle(message({ subject: "  " }), BOB)).toBe(`Email from Bob`);
    expect(routedMailTitle(message({ subject: "x".repeat(200) }), BOB).length).toBe(80);
  });
});
