import { describe, expect, it } from "vitest";

import { mailboxReplyNeedsNoEmail } from "./mailbox-notify.ts";

describe("shared-mailbox completion notices", () => {
  it("skips the completion email for NO_ACTION replies, Markdown or not", () => {
    expect(mailboxReplyNeedsNoEmail("NO_ACTION")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("NO_ACTION: invite noted")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("**NO_ACTION**")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("no_action")).toBe(true);
    expect(mailboxReplyNeedsNoEmail("I scheduled the reminder.")).toBe(false);
    expect(mailboxReplyNeedsNoEmail(undefined)).toBe(false);
  });
});
