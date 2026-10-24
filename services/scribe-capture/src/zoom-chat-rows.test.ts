import assert from "node:assert/strict";
import test from "node:test";

import {
  assignRowKeys,
  dropNested,
  pickStamp,
  platformIdFromAttrs,
  resolveFallbackText,
  unionRows,
  type ChatRowIdentity,
} from "./zoom-chat-rows.js";

function identity(over: Partial<ChatRowIdentity> & { sender: string; text: string }): ChatRowIdentity {
  return { platformId: null, stamp: null, index: 0, ...over };
}

test("a panel mixing selector families keeps every row", () => {
  const a = { row: "a" };
  const b = { row: "b" };
  const c = { row: "c" };
  const merged = unionRows([[a, b], [b, c]]);
  assert.deepEqual(merged, [a, b, c]);
});

test("a row nested inside another matched row is scanned once", () => {
  const outer = { name: "outer" };
  const inner = { name: "inner" };
  const sibling = { name: "sibling" };
  const parents = new Map<{ name: string }, { name: string } | null>([
    [outer, null],
    [inner, outer],
    [sibling, null],
  ]);
  assert.deepEqual(
    dropNested([outer, inner, sibling], (n) => parents.get(n) ?? null),
    [outer, sibling],
  );
});

test("only platform-shaped ids confer platform identity", () => {
  assert.equal(platformIdFromAttrs({ id: "chat-message-42", mid: null, messageId: null }), "chat-message-42");
  assert.equal(platformIdFromAttrs({ id: null, mid: "mid.abc", messageId: null }), "mid.abc");
  assert.equal(platformIdFromAttrs({ id: null, mid: null, messageId: "msg-1" }), "msg-1");
  assert.equal(platformIdFromAttrs({ id: "panel-root", mid: null, messageId: null }), null);
  assert.equal(platformIdFromAttrs({ id: "", mid: null, messageId: null }), null);
});

test("a rebuilt list re-rendering the same messages yields the same keys", () => {
  const first = assignRowKeys([
    identity({ platformId: "chat-message-7", sender: "Micheal", text: "thanks" }),
    identity({ index: 1, sender: "Micheal", text: "thanks", stamp: "10:20" }),
    identity({ index: 2, sender: "Pranam", text: "hello" }),
  ]);
  const second = assignRowKeys([
    identity({ platformId: "chat-message-7", sender: "Micheal", text: "thanks" }),
    identity({ index: 1, sender: "Micheal", text: "thanks", stamp: "10:20" }),
    identity({ index: 2, sender: "Pranam", text: "hello" }),
  ]);
  assert.deepEqual(second, first);
});

test("a recycled node showing a new message yields a new key", () => {
  const before = assignRowKeys([identity({ index: 0, sender: "Micheal", text: "thanks" })]);
  const after = assignRowKeys([identity({ index: 0, sender: "Micheal", text: "welcome" })]);
  assert.notEqual(after[0], before[0]);
});

test("identical texts at different positions stay distinct and stable", () => {
  const first = assignRowKeys([
    identity({ index: 0, sender: "Micheal", text: "thanks" }),
    identity({ index: 1, sender: "Micheal", text: "thanks" }),
  ]);
  assert.notEqual(first[0], first[1]);
  const second = assignRowKeys([
    identity({ index: 0, sender: "Micheal", text: "thanks" }),
    identity({ index: 1, sender: "Micheal", text: "thanks" }),
  ]);
  assert.deepEqual(second, first);
});

test("identical content scanned twice in one render stays distinct", () => {
  const keys = assignRowKeys([
    identity({ sender: "Micheal", text: "thanks", stamp: "10:20" }),
    identity({ sender: "Micheal", text: "thanks", stamp: "10:20" }),
  ]);
  assert.notEqual(keys[0], keys[1]);
});

test("the row timestamp attribute separates otherwise identical rows", () => {
  const keys = assignRowKeys([
    identity({ sender: "Micheal", text: "thanks", stamp: "10:20" }),
    identity({ sender: "Micheal", text: "thanks", stamp: "10:21" }),
  ]);
  assert.notEqual(keys[0], keys[1]);
});

test("pickStamp returns the first present timestamp", () => {
  assert.equal(pickStamp([null, " ", "10:20", "10:21"]), "10:20");
  assert.equal(pickStamp([null, undefined, "  "]), null);
});

test("a long sender name is never stored as the message body", () => {
  assert.equal(
    resolveFallbackText(["Alexander Constantinople Fitzsimmons", "ok"], "Alexander Constantinople Fitzsimmons", true),
    "ok",
  );
});

test("fallback text without an identified sender is dropped", () => {
  assert.equal(resolveFallbackText(["ok"], "", false), null);
  assert.equal(resolveFallbackText(["Some Name", "ok"], "Some Name", false), null);
});

test("fallback text that is only the sender name or a timestamp is dropped", () => {
  assert.equal(resolveFallbackText(["Micheal"], "Micheal", true), null);
  assert.equal(resolveFallbackText(["Micheal", "10:20 AM"], "Micheal", true), null);
});

test("a combined sender and timestamp leaf yields the body, never the header", () => {
  assert.equal(resolveFallbackText(["Micheal 10:20 AM", "ok"], "Micheal", true), "ok");
});

test("a combined sender and timestamp leaf alone is dropped", () => {
  assert.equal(resolveFallbackText(["Micheal 10:20 AM"], "Micheal", true), null);
});
