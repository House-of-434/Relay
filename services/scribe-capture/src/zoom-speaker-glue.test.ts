import assert from "node:assert/strict";
import { dirname, join as joinPath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createZoomSpeakerGlue } from "./zoom-speaker-glue.js";

interface TrackNameResolverLike {
  onSpeak(name: string | null, tMs: number, isEnd: boolean): void;
  markHot(channel: number, tsMs: number, energy: number): void;
  resolve(channel: number, tsMs: number): string | undefined;
  nameFor(channel: number): string | undefined;
}

async function loadResolverModule(): Promise<{
  createTrackNameResolver: (opts?: Record<string, unknown>) => TrackNameResolverLike;
}> {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = joinPath(here, "../../../third_party/vexa-capture/core/meetings/modules/zoom-capture/src/track-name-resolver.js");
  return (await import(spec)) as unknown as {
    createTrackNameResolver: (opts?: Record<string, unknown>) => TrackNameResolverLike;
  };
}

test("silence closes the previous speaker interval instead of passing null through", () => {
  const calls: Array<{ name: string | null; now: number; isEnd: boolean }> = [];
  const feed = createZoomSpeakerGlue({
    onSpeak: (name, tMs, isEnd) => {
      calls.push({ name, now: tMs, isEnd });
    },
  });
  feed("Alice", 1000);
  feed(null, 2000);
  assert.deepEqual(calls, [
    { name: "Alice", now: 1000, isEnd: false },
    { name: "Alice", now: 2000, isEnd: true },
  ]);
  feed(null, 3000);
  assert.equal(calls.length, 2);
  feed("Bob", 4000);
  assert.deepEqual(calls[2], { name: "Bob", now: 4000, isEnd: false });
});

test("a silent gap keeps a stale name off another channel, then the next speaker binds", async () => {
  const { createTrackNameResolver } = await loadResolverModule();
  const resolver = createTrackNameResolver({ mode: "exclusive" });
  const feed = createZoomSpeakerGlue(resolver);
  let t = 1_000;
  feed("Alice", t);
  for (let i = 0; i < 2; i++) {
    resolver.markHot(2, t, 0.5);
    resolver.resolve(2, t);
    t += 10;
  }
  assert.equal(resolver.nameFor(2), "Alice");
  t += 700;
  feed(null, t);
  t += 10;
  for (let i = 0; i < 3; i++) {
    resolver.markHot(5, t, 0.5);
    resolver.resolve(5, t);
    t += 10;
  }
  assert.equal(resolver.nameFor(5), undefined);
  feed("Bob", t);
  for (let i = 0; i < 3; i++) {
    resolver.markHot(5, t, 0.5);
    resolver.resolve(5, t);
    t += 10;
  }
  assert.equal(resolver.nameFor(5), "Bob");
  assert.equal(resolver.nameFor(2), "Alice");
});
