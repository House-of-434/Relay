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
  /** Composer keeps the text after send (focus lost / wrong box). */
  stuckAfterSend?: boolean;
}

interface FakeLocator {
  first(): FakeLocator;
  isVisible(): Promise<boolean>;
  fill(text: string): Promise<void>;
  click(): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
}

function fakePage(options: FakeOptions = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let visible = options.openInitially ?? false;
  let content = "";

  const inputLocator: FakeLocator = {
    first: () => inputLocator,
    isVisible: async (): Promise<boolean> => visible,
    fill: async (text: string): Promise<void> => {
      if (options.fillThrows) throw new Error("fill failed");
      calls.push(`fill:${text}`);
      content = text;
    },
    click: async (): Promise<void> => {
      calls.push("click:input");
    },
    inputValue: async (): Promise<string> => options.stuckAfterSend ? content : "",
    textContent: async (): Promise<string | null> => options.stuckAfterSend ? content : "",
  };
  const buttonLocator: FakeLocator = {
    first: () => buttonLocator,
    isVisible: async (): Promise<boolean> => options.buttonVisible ?? true,
    fill: async (): Promise<void> => {},
    click: async (): Promise<void> => {
      calls.push("click:chat");
      if (options.buttonOpens ?? true) visible = true;
    },
  };
  const page: any = {
    locator: (_selector: string) => inputLocator,
    getByRole: (_role: string, _opts: unknown) => buttonLocator,
    waitForTimeout: async (): Promise<void> => {},
    keyboard: {
      press: async (key: string): Promise<void> => { calls.push(`press:${key}`); },
      type: async (text: string): Promise<void> => { calls.push(`type:${text}`); content = text; },
    },
  };
  page.mainFrame = () => page;
  page.frames = () => [page];
  return { page: page as Page, calls, logs };
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

test("sendMeetChat falls back to click+type when fill() is unsupported", async () => {
  // Meet's Google Chat composer is a div[role=textbox] with no contenteditable,
  // which Playwright's fill() refuses — so we click and type instead.
  const { page, calls } = fakePage({ openInitially: true, fillThrows: true });
  await sendMeetChat(page, "hello");
  assert.deepEqual(calls, ["click:input", "type:hello", "press:Enter"]);
});

test("sendMeetChat rejects a message over Meet's own limit", async () => {
  const { page } = fakePage({ openInitially: true });
  await assert.rejects(() => sendMeetChat(page, "x".repeat(MEET_CHAT_MAX + 1)), /500 characters/);
});

test("sendMeetChat logs which composer matched", async () => {
  const { page, logs } = fakePage({ openInitially: true });
  await sendMeetChat(page, "hello", 1500, 16, (m) => logs.push(m));
  assert.ok(logs.some((line) => line.includes("chat composer matched")));
});

test("sendMeetChat throws when the composer keeps the message", async () => {
  const { page } = fakePage({ openInitially: true, stuckAfterSend: true });
  await assert.rejects(() => sendMeetChat(page, "hello"), /still holds the message/);
});

test("postMeetDisclosure retries a stuck send once, then uses the fallback", async () => {
  const { page, calls } = fakePage({ openInitially: true, stuckAfterSend: true });
  let seen: string | undefined;
  const outcome = await postMeetDisclosure(page, "notice", {
    fallback: async (_page, text) => { seen = text; },
  });
  assert.equal(outcome, "fallback");
  assert.equal(seen, "notice");
  assert.equal(calls.filter((c) => c === "fill:notice").length, 2);
});

test("postMeetDisclosure reports failure after two stuck attempts with no fallback", async () => {
  const { page } = fakePage({ openInitially: true, stuckAfterSend: true });
  assert.equal(await postMeetDisclosure(page, "notice"), "failed");
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
