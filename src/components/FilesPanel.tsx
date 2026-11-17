// The right-slot Files panel: one managed source of truth for the files in
// this conversation's thread folder. Bytes are read through the file-id
// routes; no host path ever reaches the renderer.
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileCode2, FileImage, FileText, Loader2, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { docTypeLabel } from "@/lib/doc-refs";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { ChatMarkdown } from "./ChatMarkdown";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  deleteFile,
  downloadFile,
  fetchFileText,
  fetchThreadFiles,
  fileContentUrl,
  formatBytes,
  isImage,
  isPdf,
  isText,
  type ListedFile,
  type ListedFiles,
} from "@/lib/files";

function FileIcon({ file, size = 16 }: { file: ListedFile; size?: number }) {
  const Icon = isImage(file) ? FileImage : isText(file) ? FileCode2 : FileText;
  return <Icon size={size} className="shrink-0 text-ink-secondary" />;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase().slice(0, 5);
}

function FilePreview({ file }: { file: ListedFile }) {
  if (isImage(file)) {
    return <img src={fileContentUrl(file.fileId)} alt="" loading="lazy" className="size-full object-cover" />;
  }
  if (isPdf(file)) {
    return (
      <iframe
        src={`${fileContentUrl(file.fileId)}#toolbar=0&navpanes=0&view=FitH`}
        title={file.name}
        tabIndex={-1}
        loading="lazy"
        className="pointer-events-none size-full border-0 bg-inset"
      />
    );
  }
  const extension = extensionOf(file.name);
  return (
    <span className="flex flex-col items-center gap-1.5 text-ink-secondary">
      <FileIcon file={file} size={22} />
      {extension && <span className="text-[10px] font-medium tracking-wide">{extension}</span>}
    </span>
  );
}

export function FilesPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [data, setData] = useState<ListedFiles | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ListedFile | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ListedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchThreadFiles(bot.id, bot.threadId);
      if (controller.signal.aborted) return;
      setData(next);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [bot.id, bot.threadId]);

  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setData(null);
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!selected || !isText(selected)) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    fetchFileText(selected.fileId, controller.signal)
      .then((text) => { if (!controller.signal.aborted) setPreview(text); })
      .catch(() => { if (!controller.signal.aborted) setPreview(null); });
    return () => controller.abort();
  }, [selected]);

  const files = data?.files ?? [];
  const external = data?.external === true;
  const unsupported = data?.unsupported === "ownerless";

  const choose = (file: ListedFile) => {
    setSelected((current) => current?.fileId === file.fileId ? null : file);
  };

  const download = (file: ListedFile) => {
    void downloadFile(file.fileId, file.name).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteFile(pendingDelete.fileId);
      if (selected?.fileId === pendingDelete.fileId) setSelected(null);
      setPendingDelete(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside aria-label={t("files.title")} className="animate-panel-in absolute bottom-0 left-0 right-0 top-[var(--relay-chat-header-height,50.5px)] z-40 flex min-w-0 flex-col border-l border-hairline/40 bg-app lg:static lg:z-auto lg:w-[min(460px,45vw)] lg:shrink-0 lg:pt-[var(--relay-chat-header-height,50.5px)]">
      <div className={cn("flex items-center justify-between px-4 py-3", padClass)}>
        <span className="text-[15px] font-semibold text-ink">{t("files.title")}</span>
        <button
          onClick={() => dispatch({ type: "toggleFiles", open: false })}
          aria-label={t("files.close")}
          title={t("files.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !data && <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("files.loading")}</div>}
        {error && <div className="px-4 py-3 text-[13px] text-danger">{error}</div>}
        {external && (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">{t("files.external", { path: data?.cwd ?? "" })}</div>
        )}
        {unsupported && <div className="px-4 py-6 text-[13px] text-ink-secondary">{t("files.ownerless")}</div>}
        {!loading && !error && !external && !unsupported && files.length === 0 && (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">{t("files.emptyThread")}</div>
        )}
        {files.length > 0 && (
          <div role="list" className="flex flex-col gap-3 p-3">
            {files.map((file) => {
              const active = selected?.fileId === file.fileId;
              return (
                <article key={file.fileId} role="listitem" className="group/file relative min-w-0">
                  <button
                    type="button"
                    onClick={() => choose(file)}
                    className="flex w-full min-w-0 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                  >
                    <span
                      className={cn(
                        "flex h-52 w-full items-center justify-center overflow-hidden rounded-xl border bg-panel transition-colors",
                        active ? "border-accent/60 ring-1 ring-accent/30" : "border-hairline/40 group-hover/file:border-hairline/70",
                      )}
                    >
                      <FilePreview file={file} />
                    </span>
                    <span className="mt-2 block min-w-0 px-0.5">
                      <span className="block truncate text-[13px] text-ink" title={file.name}>{file.name}</span>
                      <span className="block text-[11px] text-ink-secondary">{docTypeLabel(file.name)}</span>
                    </span>
                  </button>
                  <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover/file:opacity-100 group-focus-within/file:opacity-100 touch:opacity-100">
                    <button type="button" onClick={() => download(file)} aria-label={t("files.download")} title={t("files.download")} className="rounded-md bg-panel/90 p-1 text-ink-secondary shadow-sm backdrop-blur-sm hover:bg-raised hover:text-ink">
                      <Download size={13} />
                    </button>
                    <button type="button" onClick={() => setPendingDelete(file)} aria-label={t("files.delete")} title={t("files.delete")} className="rounded-md bg-panel/90 p-1 text-ink-secondary shadow-sm backdrop-blur-sm hover:bg-raised hover:text-danger">
                      <Trash2 size={13} />
                    </button>
                  </span>
                </article>
              );
            })}
          </div>
        )}
        {data?.truncated && <div className="px-4 py-2 text-[11px] text-ink-tertiary">{t("files.truncated")}</div>}
      </div>

      {selected && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-hairline/40 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <FileIcon file={selected} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{selected.name}</span>
            <button type="button" onClick={() => download(selected)} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink" title={t("files.download")} aria-label={t("files.download")}><Download size={14} /></button>
            <button type="button" onClick={() => setSelected(null)} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink" title={t("files.closePreview")} aria-label={t("files.closePreview")}><X size={14} /></button>
          </div>
          {isImage(selected) ? (
            <img src={fileContentUrl(selected.fileId)} alt={selected.name} className="max-h-64 w-full rounded-lg border border-hairline/40 object-contain" />
          ) : isPdf(selected) ? (
            <iframe src={fileContentUrl(selected.fileId)} title={selected.name} className="h-64 w-full rounded-lg border border-hairline/40 bg-inset" />
          ) : isText(selected) ? (
            preview === null
              ? <div className="text-[12px] text-ink-secondary">{t("files.loading")}</div>
              : selected.name.toLowerCase().endsWith(".md")
                ? <div className="text-[13px]"><ChatMarkdown text={preview} /></div>
                : <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-2 font-mono text-[11.5px] text-ink">{preview}</pre>
          ) : (
            <div className="text-[12px] text-ink-secondary">{t("files.noPreview")} · {formatBytes(selected.bytes)}</div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("files.deleteConfirm")}
        body={t("files.deleteBody", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("files.delete")}
        tone="danger"
        pending={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void remove()}
      />
    </aside>
  );
}
