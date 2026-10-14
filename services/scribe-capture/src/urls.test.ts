import assert from "node:assert/strict";
import test from "node:test";

import { hostAllowed, meetCode, nativeIdFor } from "./urls.js";

test("meetCode extracts the Meet code", () => {
  assert.equal(meetCode("https://meet.google.com/abc-defg-hij?authuser=0"), "abc-defg-hij");
  assert.equal(meetCode("https://zoom.us/j/123"), null);
});

test("nativeIdFor per platform", () => {
  assert.equal(nativeIdFor("google_meet", "https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(nativeIdFor("zoom", "https://us02web.zoom.us/j/9876543210?pwd=x"), "9876543210");
  assert.equal(nativeIdFor("zoom", "https://zoom.us/wc/555"), "555");
  assert.equal(nativeIdFor("teams", "https://teams.live.com/meet/9336569415432?p=abc"), "9336569415432");
  assert.equal(nativeIdFor("teams", "https://teams.microsoft.com/l/meetup-join/x"), null);
});

test("hostAllowed is per-platform and fail-closed", () => {
  assert.equal(hostAllowed("google_meet", "https://meet.google.com/x"), true);
  assert.equal(hostAllowed("zoom", "https://us02web.zoom.us/j/1"), true);
  assert.equal(hostAllowed("teams", "https://teams.live.com/meet/1"), true);
  assert.equal(hostAllowed("google_meet", "https://zoom.us/j/1"), false);
  assert.equal(hostAllowed("teams", "https://evil.example.com/meet"), false);
  assert.equal(hostAllowed("zoom", "not a url"), false);
});
