/** Shared browser context: single-flight launch and failure recovery. The
 * launch is injected — no real browser in tests. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  resetSharedBrowserContextForTests,
  sharedBrowserContext,
} from "./shared-browser.js";

const options = (launch: (options: {
  profileDir: string;
  headless: boolean;
  args: string[];
  locale: string;
}) => Promise<never>) => ({
  profileDir: "/tmp/scribe-test-profile",
  headless: true,
  args: [],
  locale: "en-US",
  launch: launch as never,
});

test("concurrent first joins share one browser launch", async () => {
  resetSharedBrowserContextForTests();
  try {
    let launches = 0;
    const fake = { newPage: async () => ({}) };
    const launch = async () => {
      launches += 1;
      await new Promise((r) => setTimeout(r, 10));
      return fake;
    };
    const [a, b] = await Promise.all([
      sharedBrowserContext(options(launch)),
      sharedBrowserContext(options(launch)),
    ]);
    assert.equal(a, b);
    assert.equal(launches, 1);
  } finally {
    resetSharedBrowserContextForTests();
  }
});

test("a failed launch does not poison later joins", async () => {
  resetSharedBrowserContextForTests();
  try {
    let calls = 0;
    const good = { newPage: async () => ({}) };
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("profile locked");
      return good;
    };
    await assert.rejects(sharedBrowserContext(options(flaky)), /profile locked/);
    const retry = await sharedBrowserContext(options(flaky));
    assert.equal(retry, good);
    assert.equal(calls, 2);
  } finally {
    resetSharedBrowserContextForTests();
  }
});
