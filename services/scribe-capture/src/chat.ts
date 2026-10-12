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

/** The first visible chat composer across the page and every frame, or null. */
async function visibleInput(page: Page): Promise<Locator | null> {
  const scopes: Array<Page | Frame> = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const scope of scopes) {
    for (const selector of MEET_CHAT_INPUTS) {
      const locator = scope.locator(selector).first();
      try {
        if (await locator.isVisible()) return locator;
      } catch {
        /* try the next selector / frame */
      }
    }
  }
  return null;
}

/** Open the chat panel once if needed and poll for the composer. */
async function openChat(page: Page, timeoutMs: number, polls: number): Promise<Locator | null> {
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
  let input: Locator | null = null;
  for (let poll = 0; poll < polls && !input; poll++) {
    await page.waitForTimeout(300);
    input = await visibleInput(page);
  }
  return input;
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

/** Scripted Meet chat send. Throws when the composer never appears. */
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
  const input = await openChat(page, timeoutMs, polls);
  if (!input) {
    await logChatSurface(page, log);
    throw new Error("Meet chat input is not available");
  }
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
}

/** Post the disclosure once: scripted first, then the optional agent fallback.
 *  Never throws; returns what happened so the caller records `disclosure_posted`. */
export async function postMeetDisclosure(
  page: Page,
  text: string,
  deps: DisclosureDeps = {},
): Promise<DisclosureOutcome> {
  const log = deps.log ?? ((): void => {});
  const message = text.trim();
  if (!message) return "failed";

  try {
    await sendMeetChat(page, message, deps.timeoutMs, deps.polls, log);
    log("scribe: join disclosure posted to Meet chat");
    return "sent";
  } catch (error) {
    log(`scribe: scripted Meet chat send failed: ${error instanceof Error ? error.message : "unknown"}`);
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
