import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export interface GitAuditRow {
  at: string;
  userId: string;
  botId: string;
  threadId: string;
  repo: string;
  branch: string;
  commit: string;
  operation: "publish";
  outcome: "approved" | "denied" | "failed" | "published";
  prUrl?: string;
  error?: string;
}

/** Durable, owner-only repository operation journal. Never contains a
 * credential; the payload is the approved identity and commit. */
export function appendGitAudit(row: GitAuditRow): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(join(DATA_DIR, "git-operations.ndjson"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Auditing must never undo a publish;
    // the transcript still carries the outcome.
  }
}
