// The Files library: a stable id over files that already live in a user's
// managed thread folders. Nothing is copied, moved, or watched. The
// filesystem stays the source of truth; SQLite only remembers the path -> id
// mapping so another thread or bot can refer to a file without seeing a host
// path.
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  deleteFileRecord,
  fileRecordById,
  fileRecordByPath,
  insertFileRecord,
  type FileRecord,
} from "./message-db.ts";
import { mimeFor } from "./message-file.ts";
import { userThreadsDir } from "./user-paths.ts";

export const FILE_ID_PATTERN = /^file_[a-z0-9]{6,32}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SKIPPED_NAMES = new Set(["node_modules", ".git", ".venv", "__pycache__", ".next", ".cache", ".turbo"]);
const MAX_THREAD_ENTRIES = 500;
const MAX_ALL_ENTRIES = 2_000;
const MAX_DEPTH = 8;

export interface ListedFile {
  fileId: string;
  name: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  mime: string;
  botId?: string;
  threadId?: string;
}

export interface ListedFiles {
  files: ListedFile[];
  truncated: boolean;
}

export interface ResolvedFile {
  record: FileRecord;
  bytes: number;
  mtimeMs: number;
  mime: string;
  name: string;
}

function newFileId(): string {
  const uuid = randomUUID().replace(/-/g, "");
  let id = "file_";
  for (let index = 0; index < 10; index += 1) id += ID_ALPHABET[Number.parseInt(uuid.slice(index * 2, index * 2 + 2), 16) % ID_ALPHABET.length];
  return id;
}

function safeIdPart(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** The one managed folder a direct bot thread owns. */
export function managedThreadRoot(ownerUserId: string, botId: string, threadId: string): string {
  if (!safeIdPart(botId) || !safeIdPart(threadId)) throw new Error("Invalid bot or thread id for a files folder.");
  return join(userThreadsDir(ownerUserId), botId, threadId);
}

export function managedFilesRoot(ownerUserId: string): string {
  return userThreadsDir(ownerUserId);
}

function contained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function skipped(name: string): boolean {
  return name.startsWith(".") || SKIPPED_NAMES.has(name) || name.endsWith(".partial");
}

/** Where a canonical managed path sits: bot, thread, and its path inside the
 * thread. Returns null for anything outside the user's managed root. */
export function managedLocationForPath(ownerUserId: string, path: string): { botId: string; threadId: string; relativePath: string } | null {
  const root = managedFilesRoot(ownerUserId);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    return null;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return null;
  }
  if (!contained(canonicalRoot, canonical) || canonical === canonicalRoot) return null;
  const parts = relative(canonicalRoot, canonical).split(sep);
  if (parts.length < 3) return null;
  const [botId, threadId, ...rest] = parts;
  if (!botId || !threadId || rest.length === 0) return null;
  return { botId, threadId, relativePath: rest.join("/") };
}

/** Mint (or return) the id for one managed file. The caller has already
 * established that the path belongs to this user; this function re-checks it
 * so an id can never be minted for an arbitrary host path. */
export function mintFileId(ownerUserId: string, path: string): FileRecord | null {
  if (!regularFile(path)) return null;
  const location = managedLocationForPath(ownerUserId, path);
  if (!location) return null;
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    return null;
  }
  const existing = fileRecordByPath(canonical);
  if (existing) return existing.ownerUserId === ownerUserId ? existing : null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const record: FileRecord = {
      id: newFileId(),
      ownerUserId,
      botId: location.botId,
      threadId: location.threadId,
      path: canonical,
    };
    const stored = insertFileRecord(record);
    if (stored) return stored;
  }
  return null;
}

/** Resolve an id for the owner. A deleted file prunes its row and reads as
 * not found; a path that escaped the owner's root is refused. */
export function resolveFile(ownerUserId: string, fileId: string): ResolvedFile | null {
  if (!FILE_ID_PATTERN.test(fileId)) return null;
  const record = fileRecordById(fileId);
  if (!record || record.ownerUserId !== ownerUserId) return null;
  if (!regularFile(record.path)) {
    deleteFileRecord(record.id);
    return null;
  }
  const location = managedLocationForPath(ownerUserId, record.path);
  if (!location) {
    deleteFileRecord(record.id);
    return null;
  }
  let canonical: string;
  let stat;
  try {
    canonical = realpathSync(record.path);
    stat = statSync(canonical);
  } catch {
    deleteFileRecord(record.id);
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    record: { ...record, path: canonical },
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: mimeFor(canonical),
    name: canonical.split(sep).at(-1) ?? "file",
  };
}

/** UI deletion only: managed files, never a custom folder or a VM home. */
export function deleteFile(ownerUserId: string, fileId: string): { ok: true; name: string } | { ok: false; status: number; error: string } {
  if (!FILE_ID_PATTERN.test(fileId)) return { ok: false, status: 400, error: "fileId is invalid" };
  const record = fileRecordById(fileId);
  if (!record || record.ownerUserId !== ownerUserId) return { ok: false, status: 404, error: "no such file" };
  if (!managedLocationForPath(ownerUserId, record.path)) return { ok: false, status: 403, error: "only managed thread files can be deleted here" };
  if (!regularFile(record.path)) {
    deleteFileRecord(record.id);
    return { ok: false, status: 404, error: "no such file" };
  }
  const name = record.path.split(sep).at(-1) ?? "file";
  try {
    unlinkSync(record.path);
  } catch {
    return { ok: false, status: 500, error: "could not delete that file" };
  }
  deleteFileRecord(record.id);
  return { ok: true, name };
}

export function listThreadFiles(ownerUserId: string, botId: string, threadId: string): ListedFiles {
  const root = managedThreadRoot(ownerUserId, botId, threadId);
  return walk(root, MAX_THREAD_ENTRIES, (path, stat) => {
    const record = mintFileId(ownerUserId, path);
    if (!record) return null;
    return {
      fileId: record.id,
      name: path.split(sep).at(-1) ?? "file",
      relativePath: relative(root, path).split(sep).join("/"),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      mime: mimeFor(path),
    };
  });
}

/** Flat All Files view over every managed thread of one user. Provenance is
 * derived from the folder layout and then stored on the row when minted. */
export function listAllFiles(ownerUserId: string): ListedFiles {
  const root = managedFilesRoot(ownerUserId);
  return walk(root, MAX_ALL_ENTRIES, (path, stat) => {
    const location = managedLocationForPath(ownerUserId, path);
    if (!location) return null;
    const record = mintFileId(ownerUserId, path);
    if (!record) return null;
    return {
      fileId: record.id,
      name: path.split(sep).at(-1) ?? "file",
      relativePath: location.relativePath,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      mime: mimeFor(path),
      botId: location.botId,
      threadId: location.threadId,
    };
  });
}

function walk(
  root: string,
  limit: number,
  include: (path: string, stat: { size: number; mtimeMs: number }) => ListedFile | null,
): ListedFiles {
  const files: ListedFile[] = [];
  let truncated = false;
  let seen = 0;
  const visit = (dir: string, depth: number) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (skipped(entry.name)) continue;
      const path = join(dir, entry.name);
      // lstat through the directory entry: a symlink is never a File.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > limit) {
        truncated = true;
        return;
      }
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const listed = include(path, stat);
      if (listed) files.push(listed);
    }
  };
  visit(root, 0);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return { files, truncated };
}
