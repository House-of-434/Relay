import { describe, expect, it } from "vitest";

import {
  relayComputerConfigRefusal,
  relayComputerDisabled,
  relayComputerRouteDisabled,
  relayComputerSettingsRefusal,
} from "./relay-policy.ts";

describe("Relay computer safety flag", () => {
  it("is opt-in and accepts only exact 0/1 values", () => {
    expect(relayComputerDisabled({})).toBe(false);
    expect(relayComputerDisabled({ RELAY_DISABLE_COMPUTER: "0" })).toBe(false);
    expect(relayComputerDisabled({ RELAY_DISABLE_COMPUTER: "1" })).toBe(true);
    expect(() => relayComputerDisabled({ RELAY_DISABLE_COMPUTER: "true" })).toThrow("must be 0 or 1");
  });
});

describe("Relay disabled computer routes", () => {
  it("blocks computer, voice, and phone endpoints without blocking Relay data or auth", () => {
    for (const path of [
      "/api/computers/vps",
      "/api/local-computer/screenshot",
      "/api/local-vm/inventory",
      "/api/internal/computer-control",
      "/api/internal/computer/select",
      "/api/internal/vm-exec",
      "/api/internal/phone/claim",
      "/api/internal/voice-note",
      "/api/bots/bot-1/computer/control",
      "/api/bots/bot-1/local-computer/run",
      "/api/bots/bot-1/secret-cards/card-1/provide",
      "/api/tts/speak",
      "/api/tts/prepare",
      "/api/calls/start",
      "/api/calendar-calls/fixture/room",
      "/api/phone/claim",
      "/api/shared-computers/connect",
    ]) expect(relayComputerRouteDisabled(path), path).toBe(true);
    for (const path of ["/api/health", "/api/config", "/api/approve", "/api/bots/bot-1/messages", "/mcp/scout"]) {
      expect(relayComputerRouteDisabled(path), path).toBe(false);
    }
  });
});

describe("Relay disabled settings refusals", () => {
  it("rejects enabling computer, VPS autostart, or voice notes but permits disabling and unrelated edits", () => {
    for (const patch of [
      { computer: "cloud" },
      { computer: null },
      { autoStartVps: true },
      { voiceNotes: true },
      { voice: "voice-1" },
    ]) expect(relayComputerSettingsRefusal(patch)).toBeTruthy();
    expect(relayComputerSettingsRefusal({ computer: "off", voiceNotes: false, title: "Scout" })).toBeNull();
    expect(relayComputerSettingsRefusal({ title: "Scout" })).toBeNull();
  });

  it("rejects config patches that turn on shared-computer, voice, or unsafe bot defaults", () => {
    for (const patch of [
      { features: { sharedComputers: true } },
      { tts: { provider: "system" } },
      { newBotDefaults: { profile: { computer: "cloud" } } },
      { newBotDefaults: { profile: { voiceNotes: true } } },
    ]) expect(relayComputerConfigRefusal(patch)).toBeTruthy();
    expect(relayComputerConfigRefusal({ profile: { name: "Relay" } })).toBeNull();
    expect(relayComputerConfigRefusal({ tts: { voice: "" } })).toBeNull();
  });
});
