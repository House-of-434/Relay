/** Capabilities the harness holds in memory only.
 *
 * Read each value out of the environment and DELETE it, at module top-level and
 * before the monitors or any engine can spawn. A child process that inherits
 * the environment (or a driver that spreads `{ ...process.env }`) therefore
 * cannot receive them.
 *
 * HONEST SCOPE: this stops INHERITANCE only. It is not a boundary — a
 * shell-capable process running as the same user can still read
 * `/proc/<pid>/environ`. A true boundary needs a different user/container.
 *
 * RELAY_INGEST_CAPABILITY is deliberately not returned: the harness must never
 * hold it at all (only `tools` and `scribe` do; enforced by the compose env_file
 * test). It is still deleted defensively, so a misconfiguration cannot leak it
 * to an engine.
 */
export interface HeldHarnessCapabilities {
  bffCapability?: string;
  scribeWorkerCapability?: string;
  /** Shared only with the BFF for the trusted mailbox reply route. */
  mailMirrorCapability?: string;
  githubWorkspaceToken?: string;
}

export function holdHarnessCapabilities(env: NodeJS.ProcessEnv = process.env): HeldHarnessCapabilities {
  const bffCapability = env.RELAY_BFF_CAPABILITY;
  const scribeWorkerCapability = env.RELAY_SCRIBE_WORKER_CAPABILITY;
  const mailMirrorCapability = env.RELAY_MAIL_MIRROR_CAPABILITY;
  const githubWorkspaceToken = env.RELAY_GITHUB_WORKSPACE_TOKEN;
  delete env.RELAY_BFF_CAPABILITY;
  delete env.RELAY_SCRIBE_WORKER_CAPABILITY;
  delete env.RELAY_MAIL_MIRROR_CAPABILITY;
  delete env.RELAY_INGEST_CAPABILITY;
  delete env.RELAY_GITHUB_WORKSPACE_TOKEN;
  return { bffCapability, scribeWorkerCapability, mailMirrorCapability, githubWorkspaceToken };
}
