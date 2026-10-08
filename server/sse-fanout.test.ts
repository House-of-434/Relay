// Unit test for the SSE write-bound decision. This drives a fake
// response object directly instead of the real HTTP harness index.test.ts
// uses elsewhere: index.ts starts a real server on import, so it can't be
// imported into a unit test, which is why this logic lives in its own file.
//
// Every event here is durable (messages, bot/group state, config, ...):
// frames are always written, and a client whose buffer exceeds the bound is
// cut loose so its next reconnect replays what it missed.
import { describe, expect, it } from "vitest";

import { deliverSseFrame, SSE_MAX_BUFFERED_BYTES, type SseFanoutClient } from "./sse-fanout.ts";

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): SseFanoutClient {
  return {
    res: {
      writableLength: 0,
      write: () => true,
      end: () => {},
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends normally while write() returns true", () => {
    const client = fakeClient();
    expect(deliverSseFrame(client, "frame-a")).toBe("sent");
  });

  it("still writes when write() returns false — nothing is silently dropped", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false;
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("sent");
    expect(deliverSseFrame(client, "message-2")).toBe("sent");
    expect(written).toEqual(["message-1", "message-2"]);
  });

  it("disconnects a client once buffered bytes exceed the bound", () => {
    let ended = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      end: () => {
        ended = true;
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("disconnected");
    expect(ended).toBe(true);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("disconnected");
  });
});
