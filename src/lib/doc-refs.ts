// Canonical document links agents put in chat to open the right-side
// doc pane: relay://doc/<threadId>/<messageId>?path=<file-path>&title=<label>.
// The granting message (threadId + messageId) is the capability the pane
// fetches through — the existing message-scoped file route — so no new
// backend is needed for markdown. Strict like thread links: anything shaped
// like this scheme must never reach the shell as an external link.
import type { WireDocRef, DocPaneType } from "../../shared/wire.ts";

export const DOC_URL_PREFIX = "relay://doc/";

const ID_PATTERN = /^[\w-]{1,256}$/;
const PATH_LIMIT = 8192;

// oxlint-disable-next-line no-control-regex -- ids never carry control characters
const CONTROL_CHARS = /[\u0000-\u001f]/;
const NUL = "\0";

const plainId = (value: string): string | null => {
  if (!ID_PATTERN.test(value)) return null;
  if (CONTROL_CHARS.test(value)) return null;
  return value;
};

const plainPath = (value: string): string | null => {
  if (!value || Buffer.byteLength(value) > PATH_LIMIT || value.includes(NUL)) return null;
  if (CONTROL_CHARS.test(value)) return null;
  return value;
};

/** Whether the pane renders this path as rich markdown. A link's
 * query and fragment belong to the link, not the filename. */
export function isMarkdownPath(value: string): boolean {
  return /\.m(?:d|arkdown)$/i.test(value.split(/[?#]/, 1)[0] ?? "");
}

const CODE_EXTENSIONS = new Set([
  "txt", "text", "log",
  "py", "pyw",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg",
  "sh", "bash", "zsh", "fish",
  "css", "html", "xml", "sql",
  "c", "h", "cpp", "hpp", "rs", "go", "java", "rb", "php", "swift", "kt",
]);

/** Which renderer the pane uses for this path, or null when the pane
 * cannot preview it. Markdown renders as rich text; anything else in the
 * set renders as highlighted source. */
export function previewableDocType(value: string): DocPaneType | null {
  const filename = (value.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  if (isMarkdownPath(value)) return "markdown";
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return extension && CODE_EXTENSIONS.has(extension) ? "code" : null;
}

const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  css: "css",
  html: "html",
  xml: "xml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
};

/** Syntax-highlight language for a previewable path. Unknown extensions
 * fall back to plain text; the highlighter itself degrades to a <pre>. */
export function docLangForPath(value: string): string {
  const filename = (value.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return (extension && LANG_BY_EXTENSION[extension]) || "text";
}

const LANG_DISPLAY: Readonly<Record<string, string>> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  tsx: "TSX",
};

/** Short type line for an attachment pill: Markdown, a language, a bare
 * extension for anything else the pane cannot preview, or File. */
export function docTypeLabel(value: string): string {
  if (isMarkdownPath(value)) return "Markdown";
  if (previewableDocType(value) === "code") {
    const lang = docLangForPath(value);
    return LANG_DISPLAY[lang] ?? (lang.charAt(0).toUpperCase() + lang.slice(1));
  }
  const clean = value.split(/[?#]/, 1)[0] ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(clean.split(/[\\/]/).filter(Boolean).at(-1) ?? "")?.[1];
  return extension ? extension.toUpperCase() : "File";
}

/** The canonical link for a document the pane can open. */
export function docRefUrl(ref: WireDocRef): string {
  let url = `${DOC_URL_PREFIX}${encodeURIComponent(ref.threadId)}/${encodeURIComponent(ref.messageId)}?path=${encodeURIComponent(ref.path)}`;
  if (ref.title) url += `&title=${encodeURIComponent(ref.title)}`;
  return url;
}

/** Parse a canonical document link; null for anything else, including
 * near-misses with extra path segments, extra query keys or a foreign host. */
export function parseDocRefUrl(value: string): WireDocRef | null {
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith(DOC_URL_PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.hostname.toLowerCase() !== "doc") return null;
  const segments = url.pathname.slice(1).split("/");
  if (segments.length !== 2) return null;
  let threadId: string;
  let messageId: string;
  try {
    threadId = decodeURIComponent(segments[0]!);
    messageId = decodeURIComponent(segments[1]!);
  } catch {
    return null;
  }
  if (
    !threadId ||
    !messageId ||
    threadId.includes("/") ||
    messageId.includes("/") ||
    segments[0] !== encodeURIComponent(threadId) ||
    segments[1] !== encodeURIComponent(messageId)
  ) {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "path" && key !== "title")) return null;
  const pathParam = url.searchParams.get("path");
  const titleParam = url.searchParams.get("title");
  if (pathParam === null || !pathParam) return null;
  if (titleParam !== null && !titleParam) return null;
  const thread = plainId(threadId);
  const message = plainId(messageId);
  const path = plainPath(pathParam);
  // The renderer follows the file extension; anything else is a dead link,
  // kept as plain text by the caller — never an external anchor.
  const type = path ? previewableDocType(path) : null;
  if (!thread || !message || !path || !type) return null;
  if (titleParam === null) return { type, threadId: thread, messageId: message, path };
  if (CONTROL_CHARS.test(titleParam) || titleParam.length > 256) return null;
  return { type, threadId: thread, messageId: message, path, title: titleParam };
}

/** Whether a value is shaped like a document link at all — even one that
 * fails strict parsing. Markdown must never hand such a URL to the shell
 * as an external link, live or dead. */
export function looksLikeDocRefUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith(DOC_URL_PREFIX);
}
