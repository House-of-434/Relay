import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("keeps computer, browser, phone, and voice features disabled across the HTTP API", async () => {
  const fixture = await launchVerificationServer({ ...process.env, RELAY_DISABLE_COMPUTER: "1" });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  try {
    const config = await api("GET", "/api/config");
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      computerDisabled: true,
      features: { browser: false, sharedComputers: false },
      tts: { configured: false, ready: false },
      browserEngine: { kind: "unavailable", reason: "disabled by RELAY_DISABLE_COMPUTER" },
    });

    const created = await api("POST", "/api/bots", { name: "Safety fixture" });
    expect(created.status).toBe(201);
    const botId = created.body.bot.id as string;
    expect(created.body.bot).toMatchObject({ computer: "off", browser: false, autoStartVps: false, voiceNotes: false });

    for (const patch of [
      { computer: "cloud" },
      { computer: null },
      { browser: true },
      { voiceNotes: true },
      { autoStartVps: true },
    ]) {
      expect((await api("PATCH", `/api/bots/${botId}`, patch)).status).toBe(403);
    }
    expect((await api("PATCH", `/api/bots/${botId}`, { description: "Still editable" })).status).toBe(200);
    expect((await api("POST", "/api/bots", { name: "Unsafe fixture", settings: { computer: "cloud" } })).status).toBe(403);

    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(403);
    expect((await api("PATCH", "/api/config", { tts: { provider: "system", voice: "fixture" } })).status).toBe(403);
    expect((await api("PATCH", "/api/config", { profile: { name: "Relay" } })).status).toBe(200);

    for (const [method, path] of [
      ["GET", "/api/computers/vps"],
      ["GET", `/api/bots/${botId}/computer`],
      ["POST", `/api/bots/${botId}/computer/provision`],
      ["POST", "/api/internal/voice-note"],
      ["POST", "/api/internal/phone/claim"],
      ["POST", "/api/tts/prepare"],
      ["POST", "/api/tts/speak"],
      ["GET", "/api/calendar-calls"],
      ["GET", "/api/shared-computers"],
    ] as const) {
      expect((await api(method, path, method === "GET" ? undefined : {})).status, `${method} ${path}`).toBe(404);
    }
  } finally {
    await fixture.close();
  }
}, 90_000);
