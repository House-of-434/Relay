// The right-side document pane: a small type → renderer registry over a
// pane shell. markdown renders as rich text, code as highlighted source
// (scripts, .txt) with no chat chrome — a document reads as a document,
// not a bubble. One registry entry each, same fetcher. The bytes come
// through the existing message-scoped file route — the granting message
// (threadId + messageId) is the capability, so this needs no new backend.
// Swapping in a future harness endpoint changes fetchDocText only;
// renderers stay untouched.
//
// The pane is a right-slot sibling like the Inspector: opening it closes
// the computer panel and the inspector (see the store reducer), and those
// close it back. It never touches the database directly.
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Check, Copy, FileText, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { requestMessageFile } from "@/components/AttachmentPreview";
import { docLangForPath, previewableDocType } from "@/lib/doc-refs";
import type { WireDocRef } from "../../shared/wire";

const DOC_PREVIEW_MAX_BYTES = 1_000_000;

const docBasename = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1)?.trim() || path;

/** Fetch the document bytes through the message-scoped file route and
 * return them as text. This is the one function a future harness endpoint
 * replaces: the registry and every renderer keep their signatures. */
export async function fetchDocText(ref: WireDocRef, signal: AbortSignal): Promise<string> {
  if (!previewableDocType(ref.path)) {
    throw new Error("This pane previews text documents.");
  }
  const response = await requestMessageFile(
    ref.path,
    { threadId: ref.threadId, messageId: ref.messageId },
    signal,
  );
  const length = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(length) && length > DOC_PREVIEW_MAX_BYTES) {
    throw new Error("This document is too large to preview.");
  }
  const text = await response.text();
  if (text.length > DOC_PREVIEW_MAX_BYTES) {
    throw new Error("This document is too large to preview.");
  }
  return text;
}

function MarkdownDocView({ docRef, text }: { docRef: WireDocRef; text: string }) {
  return (
    <div className="px-4 py-3">
      <ChatMarkdown
        text={text}
        message={{ threadId: docRef.threadId, messageId: docRef.messageId }}
      />
    </div>
  );
}

function CodeDocView({ docRef, text }: { docRef: WireDocRef; text: string }) {
  return (
    <div dir="ltr" className="px-4 py-3">
      <PreviewCode code={text} lang={docLangForPath(docRef.path)} />
    </div>
  );
}

// Highlighted source without any chat chrome: no language badge, no wrap,
// save or copy toolbar — a document reads as a document. Same dual-palette
// Shiki setup as the chat blocks, so colors follow the skin; unknown
// languages and highlight failures keep the plain <pre>.
const previewHighlightCache = new Map<string, string>();
const PREVIEW_CACHE_MAX = 100;

const previewHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export function PreviewCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    const key = `${lang}:${previewHash(code)}`;
    const cached = previewHighlightCache.get(key);
    if (cached) {
      setHtml(cached);
      return;
    }
    let alive = true;
    import("shiki")
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: lang || "text",
          themes: {
            light: "github-light-default",
            dark: "github-dark-default",
          },
          defaultColor: "light-dark()",
        }),
      )
      .then((out) => {
        if (!alive) return;
        if (previewHighlightCache.size >= PREVIEW_CACHE_MAX) {
          const first = previewHighlightCache.keys().next().value;
          if (first) previewHighlightCache.delete(first);
        }
        previewHighlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        // unknown language or shiki failed — the plain <pre> stays
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className="doc-pane-code text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="doc-pane-code whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-ink">{code}</pre>
  );
}

// The registry: one renderer per document type. A meeting or notes type
// adds its entry (and its fetcher) here without touching the shell, the
// store, or the chat interception.
const DOC_RENDERERS: Record<WireDocRef["type"], ComponentType<{ docRef: WireDocRef; text: string }>> = {
  markdown: MarkdownDocView,
  code: CodeDocView,
};

export function DocPane({ docRef }: { docRef: WireDocRef }) {
  const { dispatch } = useStore();
  // Docked flush under the Windows caption corner: drop the header 16px.
  const { padClass } = useCaptionChrome();
  const title = docRef.title ?? docBasename(docRef.path);
  const Renderer = DOC_RENDERERS[docRef.type];
  // Session-local: expansion resets when the pane closes.
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    setCopied(false);
    fetchDocText(docRef, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setText(next);
      },
      (cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load this document.");
        }
      },
    );
    return () => controller.abort();
  }, [docRef]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const copy = () => {
    if (text === null || !navigator.clipboard?.writeText) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current !== null) {
          clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard write rejected or failed silently
      });
  };

  return (
    <aside
      aria-label="Document"
      className={expanded
        ? "animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel"
        : "animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel lg:static lg:z-auto lg:w-[min(520px,45vw)] lg:shrink-0"}
    >
      <div className={cn("flex items-center justify-between gap-2 px-4 py-3", padClass)}>
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink">
          <FileText size={16} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 truncate" title={title}>{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            onClick={copy}
            disabled={text === null}
            aria-label={copied ? "Document copied to clipboard" : "Copy document to clipboard"}
            title={copied ? "Copied to clipboard" : "Copy document"}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            {copied ? <Check size={18} className="text-success" /> : <Copy size={18} />}
          </button>
          <button
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? "Restore document pane" : "Expand document pane"}
            title={expanded ? "Restore" : "Expand"}
            aria-expanded={expanded}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            onClick={() => dispatch({ type: "closeDocPane" })}
            aria-label="Close the document"
            title="Close the document"
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div role="alert" className="px-4 py-6 text-[13px] text-danger">{error}</div>
        ) : text === null ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin" /> Loading document…
          </div>
        ) : Renderer ? (
          <Renderer docRef={docRef} text={text} />
        ) : (
          <div role="alert" className="px-4 py-6 text-[13px] text-danger">
            This document type is not supported yet.
          </div>
        )}
      </div>
    </aside>
  );
}
