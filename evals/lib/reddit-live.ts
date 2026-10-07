/** Live Reddit extraction check (live-gated). Offline CI never runs a
 * browser: without BLADEBRO_LIVE=1 this reports skipped. With it, an
 * operator runs the real adapter path by hand (the eval runner uses plain
 * node type-stripping, which cannot resolve the Tool Layer's .js-style
 * sibling imports — so the live run stays a documented manual step, not a
 * committed import). A block or challenge fails loudly instead of passing
 * silently. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LiveVerdict {
  status: "passed" | "failed" | "skipped";
  reason: string;
}

export interface RedditExpectation {
  url: string;
  expectedFields: string[];
}

export function loadRedditFixture(): RedditExpectation {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "fixtures", "reddit-post.json"), "utf8");
  const data = JSON.parse(raw) as RedditExpectation;
  if (typeof data.url !== "string" || !Array.isArray(data.expectedFields)) {
    throw new Error("reddit fixture is malformed");
  }
  return data;
}

export async function redditLiveCheck(env: NodeJS.ProcessEnv = process.env): Promise<LiveVerdict> {
  if (env.BLADEBRO_LIVE !== "1") {
    return {
      status: "skipped",
      reason: "set BLADEBRO_LIVE=1 with a Bladebro binary to run the live Reddit extraction",
    };
  }
  const fixture = loadRedditFixture();
  return {
    status: "failed",
    reason:
      `live extraction is a manual step: run the adapter against ${fixture.url} ` +
      "with a Bladebro binary and Chrome, then confirm the expected fields " +
      "come back (a block or challenge fails this check loudly by design)",
  };
}
