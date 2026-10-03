export const RELAY_AGENT_ROLES = ["scout", "mercury", "curator"] as const;
export type RelayAgentRole = (typeof RELAY_AGENT_ROLES)[number];

export function isRelayAgentRole(value: unknown): value is RelayAgentRole {
  return typeof value === "string" && (RELAY_AGENT_ROLES as readonly string[]).includes(value);
}
