export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; showToolCalls?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; routinesInConversation?: boolean };
}

/** Bots may draft skills (the Verify card's Save as skill, /learn,
 * skill_manage) for the user's review. On unless the Settings toggle was
 * switched off — the same rule as the server's skillAuthoringEnabled. */
export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

/** Routine turns are written into the conversation that receives the run card.
 * Off by default — the run stays in a hidden thread and the chat only gets the card. */
export function routinesInConversationEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.routinesInConversation === true;
}

/** Opt-in computer sharing — lending this desktop's folders, terminal or
 * computer control to a connected workspace. Off unless this server was
 * explicitly switched on in its config.json; there is no Settings toggle, so
 * the controls simply are not offered. */
export function sharedComputersEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.sharedComputers === true;
}

/** Claude bots also see the MCP servers of this machine's own Claude Code
 * setup (Plugins → MCP servers). Off by default — every extra tool costs
 * tokens on each message — and mirrors the server's claudeUserMcpEnabled. */
export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}
