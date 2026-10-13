/** Deployment safety switches for the Relay fork. They are process-owned and
 * cannot be enabled or disabled through a chat/UI config patch. */
export function relayComputerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RELAY_DISABLE_COMPUTER;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("RELAY_DISABLE_COMPUTER must be 0 or 1");
}

const DISABLED_COMPUTER_ROUTES = [
  /^\/api\/(?:computers|local-computer|local-vm|team-computers|shared-computers)(?:\/|$)/,
  /^\/api\/bots\/[^/]+\/(?:computer|local-computer)(?:\/|$)/,
  /^\/api\/bots\/[^/]+\/secret-cards\/[^/]+\/provide$/,
  /^\/api\/internal\/(?:computer(?:-[^/]+)?|phone|vm-exec|shared-computers)(?:\/|$)/,
  /^\/api\/desktop\/shared-computer-control$/,
  /^\/api\/(?:calls?|calendar-calls|phone)(?:\/|$)/,
];

export function relayComputerRouteDisabled(path: string): boolean {
  return DISABLED_COMPUTER_ROUTES.some((pattern) => pattern.test(path));
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Refuse requests that would re-enable computer features while the
 * process-owned safety switch is active. Clearing or unrelated profile edits
 * remain available. */
export function relayComputerSettingsRefusal(value: unknown): string | null {
  const settings = record(value);
  if (!settings) return null;
  if (settings.computer !== undefined && settings.computer !== "off") {
    return "computer access is disabled by RELAY_DISABLE_COMPUTER";
  }
  if (settings.autoStartVps === true) {
    return "computer features are disabled by RELAY_DISABLE_COMPUTER";
  }
  return null;
}

export function relayComputerConfigRefusal(value: unknown): string | null {
  const patch = record(value);
  if (!patch) return null;
  const features = record(patch.features);
  if (features?.sharedComputers === true) return "shared computer access is disabled by RELAY_DISABLE_COMPUTER";

  const defaults = record(patch.newBotDefaults);
  const profile = record(defaults?.profile);
  const profileRefusal = relayComputerSettingsRefusal(profile);
  if (profileRefusal) return profileRefusal;

  return null;
}

/** The RELAY_SHARED_WORKSPACE lockout is gone with the flag: the computer is
 * available unless the operator sets RELAY_DISABLE_COMPUTER=1. */
export const RELAY_COMPUTER_DISABLED = relayComputerDisabled();
