import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { mailboxPromptPart } from "./system-prompt.ts";

describe("Relay mailbox prompt parity", () => {
  it("builds one section and honours the Scribe gate", () => {
    const part = mailboxPromptPart("relay@houseof434.com", false);
    expect(part.id).toBe("mailbox");
    expect(part.label).toBe("Relay mailbox");
    expect(part.text).toContain("relay@houseof434.com");
    expect(part.text).not.toContain("meeting transcribed");
    expect(mailboxPromptPart("relay@houseof434.com", true).text).toContain("meeting transcribed");
    expect(mailboxPromptPart(undefined, false).text).toBe("");
  });

  it("includes the section in every prompt path (preview, direct turn, room turn)", () => {
    // The preview, direct-turn, and room-turn prompt arrays are built inline in
    // server/index.ts. A missing entry in any one of them is a silent
    // inconsistency — a room turn that cannot see the shared mailbox — so guard
    // the count at the source. This is the regression a missing room-path
    // paragraph slipped through before.
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const uses = source.match(/mailboxPromptPart\(RELAY_MAILBOX_ADDRESS, RELAY_SCRIBE_ENABLED\)/g) ?? [];
    expect(uses).toHaveLength(3);
  });
});
