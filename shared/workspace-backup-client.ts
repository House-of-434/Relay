// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "relay-drafts",
  "relay-draft-attachments",
  "relay-draft-send-ids",
  "relay-draft-channel-modes",
  "relay-skin",
  "relay-show-threads",
  "relay.sidebarDensity",
  "relay.sidebarCollapsedSections.v1",
  "relay.sidebarSectionOrder.v1",
  "relay-analytics-opt-out",
  "relay.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
