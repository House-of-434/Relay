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
    expect(result.text).toContain("propose_profile notifications must be true or false.");
    expect(calls).toEqual([]);
  });

  it("passes boolean toggles through with the other fields", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: false, reason: "Use calmer replies." }, context({
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
          changes: { description: "Calmer replies.", notifications: false },
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
