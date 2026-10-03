/** Deployment safety switches for the Relay fork. They are process-owned and
 * cannot be enabled or disabled through a chat/UI config patch. */
export function relayComputerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RELAY_DISABLE_COMPUTER;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("RELAY_DISABLE_COMPUTER must be 0 or 1");
}

const DISABLED_COMPUTER_ROUTES = [
  /^\/api\/(?:computers|local-computer|local-vm|team-computers|shared-computers|browser-engine)(?:\/|$)/,
  /^\/api\/bots\/[^/]+\/(?:computer|local-computer)(?:\/|$)/,
  /^\/api\/bots\/[^/]+\/secret-cards\/[^/]+\/provide$/,
  /^\/api\/internal\/(?:browser|computer(?:-[^/]+)?|phone|voice(?:-[^/]+)?|vm-exec|shared-computers)(?:\/|$)/,
  /^\/api\/desktop\/shared-computer-control$/,
  /^\/api\/(?:tts|calls?|calendar-calls|voice|phone)(?:\/|$)/,
];

export function relayComputerRouteDisabled(path: string): boolean {
  return DISABLED_COMPUTER_ROUTES.some((pattern) => pattern.test(path));
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Refuse requests that would re-enable computer or voice features while the
 * process-owned safety switch is active. Clearing or unrelated profile edits
 * remain available. */
export function relayComputerSettingsRefusal(value: unknown): string | null {
  const settings = record(value);
  if (!settings) return null;
  if (settings.computer !== undefined && settings.computer !== "off") {
    return "computer access is disabled by RELAY_DISABLE_COMPUTER";
  }
  if (settings.browser === true || settings.autoStartVps === true || settings.voiceNotes === true ||
    (typeof settings.voice === "string" && settings.voice.trim() !== "")) {
    return "computer and voice features are disabled by RELAY_DISABLE_COMPUTER";
  }
  if (typeof settings.browserProfile === "string" && settings.browserProfile.length > 0) {
    return "browser access is disabled by RELAY_DISABLE_COMPUTER";
  }
  return null;
}

export function relayComputerConfigRefusal(value: unknown): string | null {
  const patch = record(value);
  if (!patch) return null;
  const features = record(patch.features);
  if (features?.browser === true) return "browser access is disabled by RELAY_DISABLE_COMPUTER";
  if (features?.sharedComputers === true) return "shared computer access is disabled by RELAY_DISABLE_COMPUTER";

  const defaults = record(patch.newBotDefaults);
  const profile = record(defaults?.profile);
  const profileRefusal = relayComputerSettingsRefusal(profile);
  if (profileRefusal) return profileRefusal;

  const voice = record(patch.tts);
  if (voice && Object.values(voice).some((entry) => typeof entry === "string" && entry.trim() !== "")) {
    return "voice features are disabled by RELAY_DISABLE_COMPUTER";
  }
  return null;
}

const RELAY_SHARED_WORKSPACE = process.env.RELAY_SHARED_WORKSPACE === undefined || process.env.RELAY_SHARED_WORKSPACE === "1";
export const RELAY_COMPUTER_DISABLED = relayComputerDisabled() || RELAY_SHARED_WORKSPACE;
