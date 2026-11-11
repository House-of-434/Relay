// The Files panel's client side: one shape for thread listings and All Files,
// plus the small helpers the panel renders with.
import { api } from "@/state/store";

export interface ListedFile {
  fileId: string;
  name: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  mime: string;
  botId?: string;
  threadId?: string;
  botName?: string;
  threadTitle?: string;
  deletedThread?: boolean;
}

export interface ListedFiles {
  files: ListedFile[];
  truncated: boolean;
  external?: boolean;
  cwd?: string | null;
  unsupported?: "ownerless";
}

export function fetchThreadFiles(botId: string, threadId: string): Promise<ListedFiles> {
  return api(`/api/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(threadId)}/files`);
}

export function fetchAllFiles(botId: string): Promise<ListedFiles> {
  return api(`/api/files?botId=${encodeURIComponent(botId)}`);
}

export function fileContentUrl(fileId: string, download = false): string {
  return `/api/files/${encodeURIComponent(fileId)}/content${download ? "?download=1" : ""}`;
}

export async function fetchFileText(fileId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(fileContentUrl(fileId), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

export async function downloadFile(fileId: string, name: string): Promise<void> {
  const response = await fetch(fileContentUrl(fileId, true), { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function deleteFile(fileId: string): Promise<{ ok: true; name: string }> {
  return api(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImage(file: ListedFile): boolean {
  return file.mime.startsWith("image/");
}

const TEXT_FILE = /\.(?:md|markdown|txt|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|css|html?|xml|ya?ml|toml|sh|bash|zsh|sql|log)$/i;

export function isText(file: ListedFile): boolean {
  return file.mime.startsWith("text/") || file.mime === "application/json" || TEXT_FILE.test(file.name);
}

export function isPreviewable(file: ListedFile): boolean {
  return isImage(file) || isText(file);
}

export function formatModified(at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}
