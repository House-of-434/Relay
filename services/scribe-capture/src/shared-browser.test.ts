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
}) => Promise<unknown>) => ({
  profileDir: "/tmp/scribe-test-profile",
  headless: true,
  args: [],
  locale: "en-US",
  launch: launch as never,
});

function fakeContext() {
  const listeners: Array<() => void> = [];
  const context = {
    closed: false,
    newPage: async () => ({}),
    isClosed: () => context.closed,
    on: (event: string, listener: () => void) => {
      if (event === "close") listeners.push(listener);
    },
    close: () => {
      context.closed = true;
      for (const listener of listeners) listener();
    },
  };
  return context;
}

test("concurrent first joins share one browser launch", async () => {
  resetSharedBrowserContextForTests();
  try {
    let launches = 0;
    const fake = fakeContext();
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

test("a closed context is replaced by a fresh launch", async () => {
  resetSharedBrowserContextForTests();
  try {
    let launches = 0;
    const launch = async () => {
      launches += 1;
      return fakeContext();
    };
    const first = await sharedBrowserContext(options(launch));
    first.close();
    const second = await sharedBrowserContext(options(launch));
    assert.notEqual(second, first);
    assert.equal(launches, 2);
  } finally {
    resetSharedBrowserContextForTests();
  }
});

test("a stale close cannot clear a newer context", async () => {
  resetSharedBrowserContextForTests();
  try {
    const launched: ReturnType<typeof fakeContext>[] = [];
    const launch = async () => {
      const context = fakeContext();
      launched.push(context);
      return context;
    };
    const first = await sharedBrowserContext(options(launch));
    first.close();
    const second = await sharedBrowserContext(options(launch));
    first.close();
    const third = await sharedBrowserContext(options(launch));
    assert.equal(third, second);
    assert.equal(launched.length, 2);
  } finally {
    resetSharedBrowserContextForTests();
  }
});

test("a failed launch does not poison later joins", async () => {
  resetSharedBrowserContextForTests();
  try {
    let calls = 0;
    const good = fakeContext();
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
