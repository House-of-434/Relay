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
 */
import type { Page } from "playwright";

/** Meet's own limit for one chat message. */
export const MEET_CHAT_MAX = 500;
/** The chat composer. English UI, pinned by the join browser args. */
const MEET_CHAT_INPUT = "textarea[placeholder*='Send a message']";
const MEET_CHAT_BUTTON = /^chat/i;

export type DisclosureOutcome = "sent" | "fallback" | "failed";

export interface DisclosureDeps {
  /** Agent/LLM fallback when the scripted send fails. Optional so the failure
   *  path is exercised in tests and so the worker stays non-agentic. */
  fallback?: (page: Page, text: string) => Promise<void>;
  log?: (message: string) => void;
  /** Per-step timeout for the fragile selectors. */
  timeoutMs?: number;
}

/** Open the chat panel if the composer is not already visible. */
async function openChat(page: Page, timeoutMs: number): Promise<boolean> {
  if (await page.locator(MEET_CHAT_INPUT).isVisible()) return true;
  const button = page.getByRole("button", { name: MEET_CHAT_BUTTON });
  try {
    if (!(await button.isVisible())) return false;
    await button.click({ timeout: timeoutMs });
  } catch {
    return false;
  }
  await page.waitForTimeout(Math.min(timeoutMs, 1000));
  return await page.locator(MEET_CHAT_INPUT).isVisible();
}

/** Scripted Meet chat send. Throws when the composer never appears. */
export async function sendMeetChat(page: Page, text: string, timeoutMs = 1500): Promise<void> {
  if (text.length > MEET_CHAT_MAX) {
    throw new Error(`disclosure exceeds ${MEET_CHAT_MAX} characters`);
  }
  if (!(await openChat(page, timeoutMs))) {
    throw new Error("Meet chat input is not available");
  }
  const input = page.locator(MEET_CHAT_INPUT);
  await input.fill(text, { timeout: timeoutMs });
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
    await sendMeetChat(page, message, deps.timeoutMs);
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
