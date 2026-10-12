import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { MEET_CHAT_MAX, postMeetDisclosure, sendMeetChat } from "./chat.js";
import { workerConfig } from "./config.js";

interface FakeOptions {
  openInitially?: boolean;
  buttonVisible?: boolean;
  buttonOpens?: boolean;
  fillThrows?: boolean;
}

function fakePage(options: FakeOptions = {}) {
  const calls: string[] = [];
  let visible = options.openInitially ?? false;
  const input = {
    isVisible: async (): Promise<boolean> => visible,
    fill: async (text: string): Promise<void> => {
      if (options.fillThrows) throw new Error("fill failed");
      calls.push(`fill:${text}`);
    },
  };
  const button = {
    isVisible: async (): Promise<boolean> => options.buttonVisible ?? true,
    click: async (): Promise<void> => {
      calls.push("click:chat");
      if (options.buttonOpens ?? true) visible = true;
    },
  };
  const page = {
    locator: (_selector: string) => input,
    getByRole: (_role: string, _opts: unknown) => button,
    waitForTimeout: async (): Promise<void> => {},
    keyboard: { press: async (key: string): Promise<void> => { calls.push(`press:${key}`); } },
  } as unknown as Page;
  return { page, calls };
}

test("sendMeetChat opens the chat, fills the composer, and sends", async () => {
  const { page, calls } = fakePage({ openInitially: false, buttonOpens: true });
  await sendMeetChat(page, "hello");
  assert.deepEqual(calls, ["click:chat", "fill:hello", "press:Enter"]);
});

test("sendMeetChat uses an already-open composer without clicking the button", async () => {
  const { page, calls } = fakePage({ openInitially: true });
  await sendMeetChat(page, "hi");
  assert.deepEqual(calls, ["fill:hi", "press:Enter"]);
});

test("sendMeetChat rejects a message over Meet's own limit", async () => {
  const { page } = fakePage({ openInitially: true });
  await assert.rejects(() => sendMeetChat(page, "x".repeat(MEET_CHAT_MAX + 1)), /500 characters/);
});

test("postMeetDisclosure runs the fallback when the scripted send fails", async () => {
  const { page } = fakePage({ buttonVisible: false });
  let seen: string | undefined;
  const outcome = await postMeetDisclosure(page, "notice", {
    fallback: async (_page, text) => { seen = text; },
  });
  assert.equal(outcome, "fallback");
  assert.equal(seen, "notice");
});

test("postMeetDisclosure reports failure when there is no fallback", async () => {
  const { page } = fakePage({ buttonVisible: false });
  assert.equal(await postMeetDisclosure(page, "notice"), "failed");
});

test("postMeetDisclosure does nothing for empty text", async () => {
  const { page, calls } = fakePage({ openInitially: true });
  assert.equal(await postMeetDisclosure(page, "   "), "failed");
  assert.deepEqual(calls, []);
});

test("disclosure config defaults on and can be overridden or disabled", () => {
  assert.equal(workerConfig({}).disclosure, "This meeting is transcribed by Relay AI.");
  assert.equal(workerConfig({ RELAY_SCRIBE_DISCLOSURE: "custom line" }).disclosure, "custom line");
  assert.equal(workerConfig({ RELAY_SCRIBE_DISCLOSURE: "" }).disclosure, "");
});
