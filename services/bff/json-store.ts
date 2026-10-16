import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Tiny atomic JSON file store for non-secret BFF state.
 *
 * Like the Google connection store, files are written to a temp path and
 * renamed into place, live under a private directory, and are read/written as
 * whole documents. The BFF is a single instance with durable local storage, so
 * a per-process serialize queue is sufficient. */

export function dataDirPath(dataDir: string, fileName: string): string {
  return join(dataDir, fileName);
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Serializes async work so two writers of the same file never interleave. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
