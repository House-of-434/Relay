import { describe, expect, it } from "vitest";

import {
  initialState,
  reducer,
  type Action,
} from "./store";
import type { WireDocRef } from "../../shared/wire";

// A thread switch must retire the doc preview: the ref points at the
// thread being left (messageId + path), never the one being opened.
const openRef: WireDocRef = {
  type: "markdown",
  threadId: "thread-a",
  messageId: "message-a",
  path: "report.md",
};

function withOpenDocPane() {
  return reducer(initialState, { type: "openDocPane", ref: openRef });
}

describe("thread switches clear the doc pane", () => {
  it("select clears an open doc pane (bot branch)", () => {
    const state = withOpenDocPane();
    expect(state.docPane).toEqual(openRef);
    const action: Action = { type: "select", id: "some-bot-id" };
    expect(reducer(state, action).docPane).toBeNull();
  });

  it("select clears an open doc pane (group branch)", () => {
    const state = withOpenDocPane();
    const groupId = state.groups[0]?.id;
    if (!groupId) return;
    expect(reducer(state, { type: "select", id: groupId }).docPane).toBeNull();
  });

  it("switchTask clears an open doc pane", () => {
    const state = withOpenDocPane();
    const action: Action = { type: "switchTask", botId: "bot-a", threadId: "thread-b" };
    expect(reducer(state, action).docPane).toBeNull();
  });

  it("newTask clears an open doc pane", () => {
    const state = withOpenDocPane();
    const action: Action = { type: "newTask", botId: "bot-a" };
    expect(reducer(state, action).docPane).toBeNull();
  });
});
