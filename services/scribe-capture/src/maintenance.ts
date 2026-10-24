import { readdir, stat, unlink, statfs } from "node:fs/promises";
import { join } from "node:path";

/** Files older than the retention window (pure, for tests). */
export function expiredFiles(
  entries: Array<{ path: string; mtimeMs: number }>,
  nowMs: number,
  retentionMs: number,
): string[] {
  return entries.filter((e) => nowMs - e.mtimeMs > retentionMs).map((e) => e.path);
}

/** Delete files in `dir` older than the retention window. Best-effort: a missing
 * dir or an unreadable file is not an error. Returns how many were removed. */
export async function sweepDir(dir: string, nowMs: number, retentionMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) entries.push({ path, mtimeMs: info.mtimeMs });
    } catch { /* gone */ }
  }
  let removed = 0;
  for (const path of expiredFiles(entries, nowMs, retentionMs)) {
    try {
      await unlink(path);
      removed += 1;
    } catch { /* gone */ }
  }
  return removed;
}

/** Free bytes on the filesystem holding `path`. */
export async function diskFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bsize) * Number(info.bavail);
}

export function diskFreeBelow(freeBytes: number, minBytes: number): boolean {
  return freeBytes < minBytes;
}

export async function maintainDiagnostics(
  dirs: readonly string[],
  retentionMs: number,
  nowMs: number = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const dir of dirs) removed += await sweepDir(dir, nowMs, retentionMs);
  return removed;
}
