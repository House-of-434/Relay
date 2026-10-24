import assert from "node:assert/strict";
import test from "node:test";

import { chatMessageKey, newChatSegments, SeenChatSet, toChatSegment } from "./chat-port.js";

const START = 1_700_000_000_000;

test("identical messages from distinct rows produce distinct segments", () => {
  const seen = new SeenChatSet();
  const segments = newChatSegments(
    [
      { sender: "Micheal", text: "thanks", atMs: START + 1000, ordinal: 1 },
      { sender: "Micheal", text: "thanks", atMs: START + 1000, ordinal: 2 },
    ],
    { platform: "zoom", captureStartMs: START, seen },
  );
  assert.equal(segments.length, 2);
  assert.notEqual(segments[0].segment_key, segments[1].segment_key);
  for (const segment of segments) {
    assert.ok(segment.segment_key.startsWith("chat:zoom:"));
    assert.equal(segment.source, "chat");
    assert.equal(segment.speaker, "Micheal");
    assert.equal(segment.text, "thanks");
  }
});

test("a re-poll of the same rows produces no new segments", () => {
  const seen = new SeenChatSet();
  const rows = [
    { sender: "Micheal", text: "thanks", atMs: START + 1000, ordinal: 1 },
    { sender: "Micheal", text: "thanks", atMs: START + 2000, ordinal: 2 },
  ];
  assert.equal(newChatSegments(rows, { platform: "zoom", captureStartMs: START, seen }).length, 2);
  assert.deepEqual(newChatSegments(rows, { platform: "zoom", captureStartMs: START, seen }), []);
});

test("distinct platform message ids distinguish repeats and stay stable", () => {
  const seen = new SeenChatSet();
  const first = newChatSegments(
    [{ sender: "Micheal", text: "thanks", atMs: START + 1000, message_id: "chat-message-7", ordinal: 1 }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  const second = newChatSegments(
    [{ sender: "Micheal", text: "thanks", atMs: START + 1000, message_id: "chat-message-9", ordinal: 2 }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].segment_key, second[0].segment_key);
  assert.deepEqual(
    newChatSegments(
      [{ sender: "Micheal", text: "thanks", atMs: START + 1000, message_id: "chat-message-9", ordinal: 2 }],
      { platform: "zoom", captureStartMs: START, seen },
    ),
    [],
  );
});

test("the platform id wins over the ordinal for the same row", () => {
  assert.equal(
    chatMessageKey({ sender: "Micheal", text: "thanks", atMs: START, message_id: "chat-message-7", ordinal: 1 }),
    chatMessageKey({ sender: "Micheal", text: "thanks", atMs: START + 5000, message_id: "chat-message-7", ordinal: 3 }),
  );
});

test("a row without page identity still dedupes itself across polls", () => {
  const seen = new SeenChatSet();
  const row = { sender: "Micheal", text: "thanks", atMs: START + 1000 };
  const first = newChatSegments([row], { platform: "zoom", captureStartMs: START, seen });
  assert.equal(first.length, 1);
  assert.ok(first[0].segment_key.startsWith("chat:zoom:"));
  assert.deepEqual(newChatSegments([row], { platform: "zoom", captureStartMs: START, seen }), []);
});

test("the row timestamp separates otherwise identical rows and stays stable", () => {
  const seen = new SeenChatSet();
  const first = newChatSegments(
    [{ sender: "Micheal", text: "thanks", atMs: START + 1000, stamp: "10:20" }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  const second = newChatSegments(
    [{ sender: "Micheal", text: "thanks", atMs: START + 2000, stamp: "10:21" }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].segment_key, second[0].segment_key);
  assert.deepEqual(
    newChatSegments(
      [
        { sender: "Micheal", text: "thanks", atMs: START + 3000, stamp: "10:20" },
        { sender: "Micheal", text: "thanks", atMs: START + 3000, stamp: "10:21" },
      ],
      { platform: "zoom", captureStartMs: START, seen },
    ),
    [],
  );
});

test("a recycled position showing a new message produces a new segment", () => {
  const seen = new SeenChatSet();
  const first = newChatSegments(
    [{ sender: "Micheal", text: "thanks", atMs: START + 1000, ordinal: 0 }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  const second = newChatSegments(
    [{ sender: "Micheal", text: "welcome", atMs: START + 2000, ordinal: 0 }],
    { platform: "zoom", captureStartMs: START, seen },
  );
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].segment_key, second[0].segment_key);
});

test("identical messages without page identity in one flush stay distinct", () => {
  const seen = new SeenChatSet();
  const rows = [
    { sender: "Micheal", text: "thanks", atMs: START + 1000 },
    { sender: "Micheal", text: "thanks", atMs: START + 1000 },
  ];
  const segments = newChatSegments(rows, { platform: "zoom", captureStartMs: START, seen });
  assert.equal(segments.length, 2);
  assert.notEqual(segments[0].segment_key, segments[1].segment_key);
  assert.deepEqual(newChatSegments(rows, { platform: "zoom", captureStartMs: START, seen }), []);
});

test("blank chat text stores nothing", () => {
  assert.equal(
    toChatSegment({ message_key: "id:x", sender: "Micheal", text: "   ", atMs: START, platform: "zoom" }, START),
    null,
  );
  const seen = new SeenChatSet();
  assert.deepEqual(
    newChatSegments([{ sender: "Micheal", text: "   ", atMs: START }], {
      platform: "zoom",
      captureStartMs: START,
      seen,
    }),
    [],
  );
});
