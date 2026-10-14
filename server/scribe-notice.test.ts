import { describe, expect, it } from "vitest";

import { parseAdminEmails, scribeAdminEmail, scribeOrganizerEmail } from "./scribe-notice.ts";
import type { ScribeNotice } from "./scribe-monitor.ts";

const base: ScribeNotice = {
  instance_id: "i",
  kind: "completed",
  signedOut: false,
  title: "Weekly sync",
  scheduled_end: "2026-10-11T12:30:00Z",
};

describe("scribe notices", () => {
  it("completed/partial → a ready notice", () => {
    const m = scribeOrganizerEmail(base);
    expect(m.subject).toBe("Transcript ready: Weekly sync");
    expect(m.body).toContain('"Weekly sync"');
    expect(m.body).toContain("2026-10-11");
    expect(m.body).not.toContain("couldn't join");
  });

  it("failed → a plain couldn't-join with the reason, never the re-auth text", () => {
    const m = scribeOrganizerEmail({ ...base, kind: "failed", reason: "not admitted in time" });
    expect(m.subject).toBe("Relay couldn't join: Weekly sync");
    expect(m.body).toContain("not admitted in time");
    expect(m.body.toLowerCase()).not.toContain("re-authenticate");
  });

  it("unreachable → a couldn't-join notice", () => {
    const m = scribeOrganizerEmail({ ...base, kind: "unreachable", reason: "capture service unreachable" });
    expect(m.subject).toContain("couldn't join");
    expect(m.body).toContain("capture service unreachable");
  });

  it("the admin notice tells a human how to re-authenticate", () => {
    const m = scribeAdminEmail();
    expect(m.subject).toContain("re-authentication");
    expect(m.body).toContain("plans/scribe-stt.md");
  });

  it("parses and de-duplicates the admin allow-list, dropping non-addresses", () => {
    expect(parseAdminEmails(" Boss@Corp.com, ops@corp.com ,,boss@corp.com, garbage")).toEqual([
      "boss@corp.com",
      "ops@corp.com",
    ]);
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("")).toEqual([]);
  });
});
