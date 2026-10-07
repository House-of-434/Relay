/** Live research frames for Scout turns.
 *
 * Polls the Tool Layer vision endpoint for the thread owner's workspace
 * and broadcasts fresh frames while research runs; settles one final frame
 * into the transcript at turn end. Deliberately separate from the computer
 * screen pollers: a research turn holds no computer/browser resource, so
 * the ownership-lease machinery does not apply — the fetch closure passed
 * in here is already scoped to one thread and its owner.
 *
 * Frames are deduplicated by hash both live and at settle, reusing the
 * settled-frame gate, so an idle page never spams the chat.
 */

import { screenFrameHash, settledFrameIsNews } from "./screen-frame-gate.ts";

export interface ResearchFrame {
  png: string;
  mime: string;
}

export type ResearchFrameFetch = (threadId: string) => Promise<ResearchFrame>;

export type ResearchFrameBroadcast = (message: {
  kind: "screen";
  botId: string;
  threadId: string;
  png: string;
  mime: string;
}) => void;

/** Research pages move slowly and every poll costs a screenshot: ten
 * seconds, not the computer poller's six. */
export const RESEARCH_FRAME_POLL_MS = 10_000;

interface Entry {
  timer: ReturnType<typeof setInterval>;
  botId: string;
  fetchFrame: ResearchFrameFetch;
  lastHash: string | null;
  failures: number;
}

/** A dead daemon, deleted thread, or missed teardown must not poll forever:
 * six straight failures (about a minute) stop the poller. The turn-end
 * settle fetches fresh regardless, and the next browser tool restarts
 * polling, so this only ever pauses a broken feed. */
const MAX_CONSECUTIVE_FAILURES = 6;

const polls = new Map<string, Entry>();

export function researchFramesActive(threadId: string): boolean {
  return polls.has(threadId);
}

async function pollOnce(threadId: string, broadcast: ResearchFrameBroadcast): Promise<void> {
  const entry = polls.get(threadId);
  if (!entry) return;
  let frame: ResearchFrame;
  try {
    frame = await entry.fetchFrame(threadId);
  } catch {
    const failed = polls.get(threadId);
    if (failed && (failed.failures += 1) >= MAX_CONSECUTIVE_FAILURES) stopResearchFrames(threadId);
    return;
  }
  const current = polls.get(threadId);
  if (!current || !frame.png) return;
  current.failures = 0;
  const hash = screenFrameHash(frame.png);
  if (current.lastHash === hash) return;
  current.lastHash = hash;
  broadcast({ kind: "screen", botId: current.botId, threadId, png: frame.png, mime: frame.mime });
}

export function startResearchFrames(
  botId: string,
  threadId: string,
  fetchFrame: ResearchFrameFetch,
  broadcast: ResearchFrameBroadcast,
  intervalMs: number = RESEARCH_FRAME_POLL_MS,
): void {
  if (polls.has(threadId)) return;
  polls.set(threadId, { timer: setInterval(() => void pollOnce(threadId, broadcast), intervalMs), botId, fetchFrame, lastHash: null, failures: 0 });
}

/** Stop polling unconditionally. Called at turn end and on interrupt so no
 * per-turn state survives the turn. */
export function stopResearchFrames(threadId: string): void {
  const entry = polls.get(threadId);
  if (!entry) return;
  clearInterval(entry.timer);
  polls.delete(threadId);
}

/** Turn end: one fresh frame through the fetcher bound at poller start
 * (the delegation watch entry that identified the owner may already be
 * gone), kept only when the reader cannot already see it. Never throws: a
 * missing page is not a failed turn. */
export async function settleResearchFrame(
  threadId: string,
  shownHash: string | undefined,
): Promise<ResearchFrame | null> {
  const entry = polls.get(threadId);
  stopResearchFrames(threadId);
  if (!entry) return null;
  let frame: ResearchFrame;
  try {
    frame = await entry.fetchFrame(threadId);
  } catch {
    return null;
  }
  if (!frame.png || !settledFrameIsNews(shownHash, frame.png)) return null;
  return frame;
}
