import { describe, expect, it } from "vitest";

import { publishRequestSchema, signPublishAuthorization } from "./git-broker.ts";

const base = {
  userId: "1457cb2a-7543-4b48-8854-a63cd160241f",
  botId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  threadId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  agent: "scout" as const,
  repo: "octo/repo",
  path: "repos/octo__repo",
  branch: "relay/fix-login",
  commit: "a".repeat(40),
  title: "Fix login",
  body: "Checks pass.",
  attachments: ["before.png"],
  nonce: "nonce-1234567890",
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 600,
};

describe("publish requests", () => {
  it("accepts only repository paths under repos/", () => {
    expect(publishRequestSchema.safeParse({
      repo: "octo/repo",
      branch: "relay/fix-login",
      title: "Fix login",
      body: "Checks pass.",
      path: "repos/octo__repo",
      attachments: [],
    }).success).toBe(true);
    expect(publishRequestSchema.safeParse({
      repo: "octo/repo",
      branch: "relay/fix-login",
      title: "Fix login",
      body: "Checks pass.",
      path: "../escape",
      attachments: [],
    }).success).toBe(false);
    expect(publishRequestSchema.safeParse({
      repo: "octo/repo",
      branch: "relay/..",
      title: "Fix login",
      body: "Checks pass.",
      path: "repos/octo__repo",
      attachments: [],
    }).success).toBe(false);
    expect(publishRequestSchema.safeParse({
      repo: "octo/repo",
      branch: "main",
      title: "Fix login",
      body: "Checks pass.",
      path: "repos/octo__repo",
      attachments: [],
    }).success).toBe(false);
  });

  it("signs a publish authorization only with a strong secret", () => {
    expect(() => signPublishAuthorization(base, "short")).toThrow(/RELAY_TOOL_ACTOR_SECRET/);
    expect(signPublishAuthorization(base, "x".repeat(32)).signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
