import { describe, expect, it } from "vitest";

import { PublishRequests } from "./publish-requests.ts";

const request = {
  userId: "1457cb2a-7543-4b48-8854-a63cd160241f",
  botId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  threadId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  repo: "octo/repo",
  path: "repos/octo__repo",
  branch: "relay/fix-login",
  commit: "a".repeat(40),
  title: "Fix login",
  body: "Checks pass.",
  attachments: [],
  workspace: "/tmp/workspace",
  diffStat: "1 file changed",
};

describe("publish requests", () => {
  it("consumes a request once and replays the settled outcome", () => {
    const requests = new PublishRequests(() => 1_000);
    const created = requests.submit(request);
    const first = requests.take(created.requestId, "allow");
    expect(first.state).toBe("approved");
    expect(requests.take(created.requestId, "allow")).toEqual({ state: "already", outcome: "approved" });
  });

  it("denies without executing and expires stale requests", () => {
    let now = 1_000;
    const requests = new PublishRequests(() => now);
    const created = requests.submit(request);
    expect(requests.take(created.requestId, "deny").state).toBe("denied");
    const stale = requests.submit(request);
    now += 31 * 60_000;
    expect(requests.take(stale.requestId, "allow").state).toBe("missing");
  });
});
