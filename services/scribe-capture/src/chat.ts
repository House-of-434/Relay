/** Google Meet in-meeting chat: post the one-line Scribe disclosure.
 *
 * The selector approach is adapted from joinly-ai/joinly (MIT) —
 * `providers/browser/platforms/google_meet.py` (`send_chat_message`/`_open_chat`):
 * open the chat side panel if it is closed, fill the composer, press Enter.
 *
 * Best-effort by design. The disclosure is a courtesy, so Meet UI drift must
 * never fail a capture. The scripted path runs first; when it fails the
 * optional `fallback` runs — the same harness/agent hook the join-failure path
 * uses (the worker itself is deliberately non-agentic and holds no model or BFF
 * capability, so the harness supplies the fallback).
 *
 * Meet puts the chat toggle in the bottom-right controls (a button named "Chat
 * with everyone"), and in Workspace meetings the panel is a Google Chat surface
 * that can live in a child frame — so the composer is searched across all frames.
 */
import type { Frame, Locator, Page } from "playwright";

/** Meet's own limit for one chat message. */
export const MEET_CHAT_MAX = 500;
/** The chat composer, most specific first. English UI, pinned by the join args.
 *  Meet's composer placeholder is not always "Send a message" (with chat history
 *  on it reads "History is on"), and the field can be a plaintext-only
 *  contenteditable, so the visible generic selectors are the real safety net. */
const MEET_CHAT_INPUTS = [
  "textarea[placeholder*='Send a message' i]",
  "textarea[aria-label*='Send a message' i]",
  "[role='textbox']:visible",
  "[contenteditable]:visible",
  "textarea:visible",
  "input[type='text']:visible",
];
/** Controls that open the chat side panel, most specific first. */
const MEET_CHAT_OPENERS = [
  'button[aria-label*="Chat" i]',
  '[aria-label*="Chat" i]',
  '[data-tooltip*="Chat" i]',
];

export type DisclosureOutcome = "sent" | "fallback" | "failed";

export interface DisclosureDeps {
  /** Agent/LLM fallback when the scripted send fails. Optional so the failure
   *  path is exercised in tests and so the worker stays non-agentic. */
  fallback?: (page: Page, text: string) => Promise<void>;
  log?: (message: string) => void;
  /** Per-step timeout for the fragile selectors. */
  timeoutMs?: number;
  /** How many times to poll for the composer once the panel is opened. */
  polls?: number;
}

/** The first visible chat composer across the page and every frame, with the
 * selector that matched (logged so a misdirected send is diagnosable), or
 * null. */
async function visibleInput(page: Page): Promise<{ input: Locator; selector: string; frame: string } | null> {
  const scopes: Array<{ scope: Page | Frame; name: string }> = [
    { scope: page, name: "main" },
    ...page.frames().filter((frame) => frame !== page.mainFrame()).map((frame, i) => ({ scope: frame, name: `frame[${i}]=${frame.url().slice(0, 60)}` })),
  ];
  for (const { scope, name } of scopes) {
    for (const selector of MEET_CHAT_INPUTS) {
      const locator = scope.locator(selector).first();
      try {
        if (await locator.isVisible()) return { input: locator, selector, frame: name };
      } catch {
        /* try the next selector / frame */
      }
    }
  }
  return null;
}

/** Open the chat panel once if needed and poll for the composer. */
async function openChat(page: Page, timeoutMs: number, polls: number): Promise<{ input: Locator; selector: string; frame: string } | null> {
  const alreadyOpen = await visibleInput(page);
  if (alreadyOpen) return alreadyOpen;
  const openers = [
    ...MEET_CHAT_OPENERS.map((selector) => page.locator(selector).first()),
    page.getByRole("button", { name: /chat/i }).first(),
  ];
  for (const opener of openers) {
    try {
      if (await opener.isVisible()) {
        await opener.click({ timeout: timeoutMs });
        break;
      }
    } catch {
      /* try the next opener */
    }
  }
  let found: { input: Locator; selector: string; frame: string } | null = null;
  for (let poll = 0; poll < polls && !found; poll++) {
    await page.waitForTimeout(300);
    found = await visibleInput(page);
  }
  return found;
}

/** One-time diagnostic so a selector miss is debuggable from the worker log. */
async function logChatSurface(page: Page, log: (message: string) => void): Promise<void> {
  const frames = page.frames();
  log(`scribe: frames: ${frames.length}`);
  for (const frame of frames) {
    let editables = 0;
    for (const selector of ["textarea", "input", "[contenteditable]", "[role='textbox']"]) {
      try {
        editables += await frame.locator(selector).count();
      } catch {
        /* cross-origin frame */
      }
    }
    log(`scribe: frame ${frame === page.mainFrame() ? "(main)" : frame.url().slice(0, 100)} editables=${editables}`);
  }
}

/** Read back whatever the composer holds. Prefers inputValue (real fields),
 * falls back to textContent (contenteditable/div composers). Unreadable
 * returns "" — an unreadable box must not fail the send on telemetry alone. */
async function readComposer(input: Locator): Promise<string> {
  try {
    return await input.inputValue({ timeout: 1000 });
  } catch {
    /* not a form field */
  }
  try {
    return (await input.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}

/** Scripted Meet chat send. Throws when the composer never appears, and when
 * the composer still holds the message after send (typed into the void or a
 * box that never submitted — previously reported as sent). */
export async function sendMeetChat(
  page: Page,
  text: string,
  timeoutMs = 1500,
  polls = 16,
  log: (message: string) => void = () => {},
): Promise<void> {
  if (text.length > MEET_CHAT_MAX) {
    throw new Error(`disclosure exceeds ${MEET_CHAT_MAX} characters`);
  }
  const found = await openChat(page, timeoutMs, polls);
  if (!found) {
    await logChatSurface(page, log);
    throw new Error("Meet chat input is not available");
  }
  log(`scribe: chat composer matched ${found.selector} (${found.frame})`);
  const { input } = found;
  try {
    // Preferred when the composer is a real input/textarea/contenteditable.
    await input.fill(text, { timeout: timeoutMs });
  } catch {
    // Meet's Google Chat composer is a div[role=textbox] with NO contenteditable
    // attribute, which fill() refuses. Focus it and type keystrokes instead.
    await input.click({ timeout: timeoutMs });
    await page.keyboard.type(text);
  }
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  // Delivery check: Meet clears the composer on send. Text still present
  // means focus was lost, the box re-rendered, or the wrong box got the
  // keystrokes — all previously misreported as sent.
  await page.waitForTimeout(800);
  const remaining = await readComposer(input);
  if (remaining.trim().length > 0) {
    throw new Error("composer still holds the message after send");
  }
}

/** Post the disclosure: up to two scripted attempts (focus loss and UI
 * re-renders are transient), then the optional agent fallback. Never
 * throws; returns what happened so the caller records `disclosure_posted`. */
export async function postMeetDisclosure(
  page: Page,
  text: string,
  deps: DisclosureDeps = {},
): Promise<DisclosureOutcome> {
  const log = deps.log ?? ((): void => {});
  const message = text.trim();
  if (!message) return "failed";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sendMeetChat(page, message, deps.timeoutMs, deps.polls, log);
      log("scribe: join disclosure posted to Meet chat");
      return "sent";
    } catch (error) {
      log(`scribe: scripted Meet chat send failed (attempt ${attempt}/2): ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  if (deps.fallback) {
    try {
      await deps.fallback(page, message);
      log("scribe: join disclosure posted via fallback");
      return "fallback";
    } catch (error) {
      log(`scribe: fallback Meet chat send failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  log("scribe: join disclosure could not be posted");
  return "failed";
}
