import { describe, expect, it } from "vitest";

import {
  hostAllowed,
  meetCode,
  meetingUrlFor,
  meetingUrlKey,
  nativeIdFor,
  normalizeMeetingUrlKey,
  passcodeFor,
  platformForUrl,
  redactMeetingUrlSecrets,
} from "./index.ts";

describe("platformForUrl", () => {
  it("resolves the known providers", () => {
    expect(platformForUrl("https://meet.google.com/x")).toBe("google_meet");
    expect(platformForUrl("https://us02web.zoom.us/j/123")).toBe("zoom");
    expect(platformForUrl("https://zoom.us/j/123")).toBe("zoom");
    expect(platformForUrl("https://teams.live.com/meet/123")).toBe("teams");
    expect(platformForUrl("https://teams.microsoft.com/l/meetup-join/x")).toBe("teams");
  });

  it("covers the broadened hosts (zoom.com, Teams cloud)", () => {
    expect(platformForUrl("https://zoom.com/j/123")).toBe("zoom");
    expect(platformForUrl("https://us02web.zoom.com/j/123")).toBe("zoom");
    expect(platformForUrl("https://teams.cloud.microsoft/meet/123")).toBe("teams");
  });

  it("rejects non-provider hosts and malformed URLs", () => {
    expect(platformForUrl("https://example.com/x")).toBeNull();
    expect(platformForUrl("https://corp.example.com/m/123")).toBeNull();
    expect(platformForUrl("not a url")).toBeNull();
  });
});

describe("hostAllowed", () => {
  it("is per-platform and fail-closed", () => {
    expect(hostAllowed("google_meet", "https://meet.google.com/x")).toBe(true);
    expect(hostAllowed("zoom", "https://us02web.zoom.us/j/1")).toBe(true);
    expect(hostAllowed("zoom", "https://zoom.com/j/1")).toBe(true);
    expect(hostAllowed("teams", "https://teams.live.com/meet/1")).toBe(true);
    expect(hostAllowed("teams", "https://teams.cloud.microsoft/meet/1")).toBe(true);
    expect(hostAllowed("google_meet", "https://zoom.us/j/1")).toBe(false);
    expect(hostAllowed("teams", "https://evil.example.com/meet")).toBe(false);
    expect(hostAllowed("zoom", "not a url")).toBe(false);
    expect(hostAllowed("unknown", "https://meet.google.com/x")).toBe(false);
  });
});

describe("meetingUrlFor", () => {
  it("prefers video entry point, then hangoutLink, then text", () => {
    expect(
      meetingUrlFor({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/vid" }] } }),
    ).toBe("https://meet.google.com/vid");
    expect(meetingUrlFor({ hangoutLink: "https://meet.google.com/hang" })).toBe("https://meet.google.com/hang");
    expect(meetingUrlFor({ description: "join at https://meet.google.com/desc please" })).toBe(
      "https://meet.google.com/desc",
    );
    expect(meetingUrlFor({})).toBeNull();
  });

  it("finds bare zoom.us, zoom.com, and Teams cloud links in text", () => {
    expect(meetingUrlFor({ description: "join https://zoom.us/j/123 please" })).toBe("https://zoom.us/j/123");
    expect(meetingUrlFor({ location: "https://zoom.com/j/456" })).toBe("https://zoom.com/j/456");
    expect(meetingUrlFor({ description: "see https://teams.cloud.microsoft/meet/789" })).toBe(
      "https://teams.cloud.microsoft/meet/789",
    );
  });
});

describe("passcodeFor", () => {
  it("prefers the conference entry passcode", () => {
    expect(
      passcodeFor(
        { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://x", passcode: "SECRET-999" }] } },
        "https://meet.google.com/abc",
      ),
    ).toBe("SECRET-999");
  });

  it("reads pwd/password/passcode from the query and fragment", () => {
    expect(passcodeFor({}, "https://us02web.zoom.us/j/123?pwd=abc123")).toBe("abc123");
    expect(passcodeFor({}, "https://zoom.us/j/123?password=xyz")).toBe("xyz");
    expect(passcodeFor({}, "https://zoom.us/j/123#pwd=frag1")).toBe("frag1");
    expect(passcodeFor({}, "https://zoom.us/j/123")).toBeUndefined();
    expect(passcodeFor({}, "not a url")).toBeUndefined();
  });
});

describe("redactMeetingUrlSecrets", () => {
  it("redacts every secret-bearing key in the query string", () => {
    expect(redactMeetingUrlSecrets("https://us02web.zoom.us/j/123?pwd=abc123")).toBe(
      "https://us02web.zoom.us/j/123?pwd=<redacted>",
    );
    expect(redactMeetingUrlSecrets("https://zoom.us/j/123?password=xyz")).toBe(
      "https://zoom.us/j/123?password=<redacted>",
    );
    expect(redactMeetingUrlSecrets("https://zoom.us/j/123?passcode=qrs")).toBe(
      "https://zoom.us/j/123?passcode=<redacted>",
    );
  });

  it("redacts secrets in the fragment", () => {
    expect(redactMeetingUrlSecrets("https://us02web.zoom.us/j/123#pwd=frag1")).toBe(
      "https://us02web.zoom.us/j/123#pwd=<redacted>",
    );
    expect(redactMeetingUrlSecrets("https://zoom.us/j/123#password=frag2")).toBe(
      "https://zoom.us/j/123#password=<redacted>",
    );
    expect(redactMeetingUrlSecrets("https://zoom.us/j/123#passcode=frag3")).toBe(
      "https://zoom.us/j/123#passcode=<redacted>",
    );
  });

  it("redacts mixed query and fragment secrets while leaving the rest intact", () => {
    expect(redactMeetingUrlSecrets("navigated to https://zoom.us/j/123?pwd=abc&role=1#pwd=frag failed")).toBe(
      "navigated to https://zoom.us/j/123?pwd=<redacted>&role=1#pwd=<redacted> failed",
    );
    expect(redactMeetingUrlSecrets("no secrets here https://meet.google.com/abc")).toBe(
      "no secrets here https://meet.google.com/abc",
    );
  });
});

describe("nativeIdFor / meetCode", () => {
  it("extracts per-platform ids", () => {
    expect(meetCode("https://meet.google.com/abc-defg-hij?authuser=0")).toBe("abc-defg-hij");
    expect(meetCode("https://zoom.us/j/123")).toBeNull();
    expect(nativeIdFor("google_meet", "https://meet.google.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(nativeIdFor("zoom", "https://us02web.zoom.us/j/9876543210?pwd=x")).toBe("9876543210");
    expect(nativeIdFor("zoom", "https://zoom.us/wc/555")).toBe("555");
    expect(nativeIdFor("zoom", "https://zoom.com/j/777")).toBe("777");
    expect(nativeIdFor("teams", "https://teams.live.com/meet/9336569415432?p=abc")).toBe("9336569415432");
    expect(nativeIdFor("teams", "https://teams.microsoft.com/l/meetup-join/x")).toBeNull();
  });
});

describe("meetingUrlKey / normalizeMeetingUrlKey", () => {
  it("normalizes room identity, dropping query and fragment", () => {
    expect(meetingUrlKey("google_meet", "https://meet.google.com/abc-defg-hij?pli=1#frag")).toBe(
      "google_meet|meet.google.com/abc-defg-hij",
    );
    expect(meetingUrlKey("zoom", "HTTPS://HOUSEOF434.ZOOM.US/j/123?pwd=x")).toBe("zoom|houseof434.zoom.us/j/123");
  });

  it("rejects unusable URLs", () => {
    expect(meetingUrlKey("google_meet", "http://meet.google.com/abc")).toBeNull();
    expect(meetingUrlKey("google_meet", "https://meet.google.com@127.0.0.1/")).toBeNull();
    expect(meetingUrlKey("google_meet", "not a url")).toBeNull();
  });

  it("gates on the claimed platform", () => {
    expect(normalizeMeetingUrlKey("google_meet", "https://meet.google.com/abc-defg-hij?pli=1#frag")).toBe(
      "google_meet|meet.google.com/abc-defg-hij",
    );
    expect(normalizeMeetingUrlKey("zoom", "https://meet.google.com/abc-defg-hij")).toBeNull();
    expect(normalizeMeetingUrlKey("zoom", "not a url")).toBeNull();
  });
});
