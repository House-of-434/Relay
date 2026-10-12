import { describe, expect, it } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    botId: "bot-voice",
    threadId: "thread-voice",
    depth: 0,
    externalRuntime: false,
    coordinating: false,
    sharedComputers: false,
    client: {
      api: async () => ({}),
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
    turn: {
      createdThisTurn: 0,
      roomPostsThisTurn: 0,
      threadsOpenedThisTurn: 0,
      memoryRefusalsThisTurn: 0,
      delegationTaskIdsThisTurn: new Set(),
    },
    ...overrides,
  };
}

describe("send_voice_note", () => {
  it("refuses a missing or blank note with the shape a retry needs", async () => {
    for (const args of [{}, { text: "" }, { text: "   " }]) {
      const result = await callTool("send_voice_note", args, context());
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toContain("send_voice_note needs text");
    }
  });

  it("refuses a note over 1000 characters and reports the length", async () => {
    const result = await callTool("send_voice_note", { text: "a".repeat(1001) }, context());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("1000 characters");
    expect(result.text).toContain("1001");
  });

  it("posts the trimmed verbatim note to the harness route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("send_voice_note", { text: "  Ship it.  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Voice note recorded");
    expect(calls).toEqual([
      { path: "/api/internal/voice-note", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", text: "Ship it." } },
    ]);
  });

  it("surfaces missing voice setup as a tool error, never a thrown turn", async () => {
    const result = await callTool("send_voice_note", { text: "Hello" }, context({
      client: {
        api: async () => { throw new Error("Pick a voice in the agent profile."); },
        apiResponse: async () => ({ ok: false, status: 409, body: { error: "Pick a voice in the agent profile." } }),
      },
    }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Pick a voice in the agent profile.");
  });
});

describe("create_bot", () => {
  it("passes a working folder through to the internal create route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("create_bot", { name: "Scout", role: "Ops", instructions: "Work.", cwd: "  /tmp/ops  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { id: "b1", name: "Scout", section: "Work" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      { path: "/api/internal/create-bot", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", name: "Scout", role: "Ops", instructions: "Work.", cwd: "/tmp/ops" } },
    ]);
  });
});

describe("propose_profile", () => {
  it("rejects a non-boolean toggle without proposing the valid half", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: "on" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("propose_profile notifications and speakReplies must be true or false.");
    expect(calls).toEqual([]);
  });

  it("passes boolean toggles through with the other fields", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: false, speakReplies: true, reason: "Use calmer replies." }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/profile-requests",
        body: {
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          changes: { description: "Calmer replies.", notifications: false, speakReplies: true },
          reason: "Use calmer replies.",
        },
      },
    ]);
  });
});

describe("propose_calendar_invite", () => {
  it("rejects a non-address attendee without proposing the rest", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_calendar_invite", {
      summary: "Coffee",
      start: { dateTime: "2026-10-02T15:00:00-04:00" },
      end: { dateTime: "2026-10-02T15:30:00-04:00" },
      when: "Friday at 3pm",
      attendees: ["friend@example.test", "my friend Sam"], reason: "Coffee.",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("attendee email addresses");
    expect(calls).toEqual([]);
  });

  it("passes a validated invite and ends the turn awaiting the card", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { requestId: "req-1", summary: "card-shown" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_calendar_invite", {
      summary: "Coffee",
      start: { dateTime: "2026-10-02T15:00:00-04:00" },
      end: { dateTime: "2026-10-02T15:30:00-04:00" },
      when: "Friday at 3pm",
      attendees: ["friend@example.test"], reason: "Coffee.",
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/connector-action-requests",
        body: {
          kind: "calendar-invite",
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          target: {
            summary: "Coffee",
            start: { dateTime: "2026-10-02T15:00:00-04:00" },
            end: { dateTime: "2026-10-02T15:30:00-04:00" },
            when: "Friday at 3pm",
            attendees: ["friend@example.test"],
          },
          reason: "Coffee.",
        },
      },
    ]);
    expect(result.text).toContain("not been applied yet");
  });
});

describe("propose_email_send", () => {
  it("rejects an empty body without proposing anything", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_email_send", {
      to: ["friend@example.test"], subject: "Hi", body: "   ", reason: "Hi.",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("non-empty body");
    expect(calls).toEqual([]);
  });

  it("passes the exact content and ends the turn awaiting the card", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { requestId: "req-2", summary: "card-shown" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_email_send", {
      to: ["friend@example.test"], subject: "Launch", body: "Shipping Friday.", reason: "Launch update.",
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/connector-action-requests",
        body: {
          kind: "gmail-send",
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          target: { to: ["friend@example.test"], subject: "Launch", body: "Shipping Friday." },
          reason: "Launch update.",
        },
      },
    ]);
    expect(result.text).toContain("not been applied yet");
  });
});

describe("propose_deep_research", () => {
  it("rejects an empty brief without proposing anything", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_deep_research", {
      title: "Verify claims", brief: "   ",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("posts the proposal and ends the turn awaiting the card", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { requestId: "req-research", summary: "card-shown" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_deep_research", {
      title: "Verify Electron claims", brief: "Check the four headline claims.", timeout_minutes: 30, idempotency_key: "turn-1",
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/research-requests",
        body: {
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          title: "Verify Electron claims",
          brief: "Check the four headline claims.",
          timeoutMinutes: 30,
          idempotencyKey: "turn-1",
        },
      },
    ]);
    expect(result.text).toContain("not been applied yet");
  });
});

describe("propose_email_send with cc and bcc", () => {
  it("rejects a non-address in bcc without proposing anything", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_email_send", {
      to: ["friend@example.test"], bcc: ["not an address"],
      subject: "Hi", body: "There.", reason: "Hi.",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes cc and bcc through to the pending action", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { requestId: "req-3", summary: "card-shown" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_email_send", {
      to: ["friend@example.test"], cc: ["teammate@example.test"], bcc: ["observer@example.test"],
      subject: "Launch", body: "Shipping Friday.", reason: "Launch update.",
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/connector-action-requests",
        body: {
          kind: "gmail-send",
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          target: {
            to: ["friend@example.test"],
            cc: ["teammate@example.test"],
            bcc: ["observer@example.test"],
            subject: "Launch",
            body: "Shipping Friday.",
          },
          reason: "Launch update.",
        },
      },
    ]);
  });
});
