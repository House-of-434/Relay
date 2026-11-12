// The right-slot Files panel. Two views over the same managed source of
// truth: this conversation's thread folder, and every managed file the owner
// has. Bytes are read through the file-id routes; no host path ever reaches
// the renderer.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Download, FileCode2, FileImage, FileText, FolderOpen, Loader2, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { ChatMarkdown } from "./ChatMarkdown";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  deleteFile,
  downloadFile,
  fetchAllFiles,
  fetchFileText,
  fetchThreadFiles,
  fileContentUrl,
  formatBytes,
  formatModified,
  isImage,
  isText,
  type ListedFile,
  type ListedFiles,
} from "@/lib/files";

type View = "thread" | "all";

function FileIcon({ file }: { file: ListedFile }) {
  const Icon = isImage(file) ? FileImage : isText(file) ? FileCode2 : FileText;
  return <Icon size={16} className="shrink-0 text-ink-secondary" />;
}

export function FilesPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [view, setView] = useState<View>("thread");
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
      const next = view === "thread"
        ? await fetchThreadFiles(bot.id, bot.threadId)
        : await fetchAllFiles(bot.id);
      if (controller.signal.aborted) return;
      setData(next);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [bot.id, bot.threadId, view]);

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
    <aside aria-label={t("files.title")} className="animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel lg:static lg:z-auto lg:w-[min(460px,45vw)] lg:shrink-0">
      <div className={cn("flex items-center justify-between px-4 py-3", padClass)}>
        <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <FolderOpen size={16} className="text-ink-secondary" /> {t("files.title")}
        </span>
        <button
          onClick={() => dispatch({ type: "toggleFiles", open: false })}
          aria-label={t("files.close")}
          title={t("files.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 pb-3">
        <div role="tablist" aria-label={t("files.views")} className="flex rounded-lg bg-inset p-0.5">
          {(["thread", "all"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => setView(tab)}
              className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium", view === tab ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}
            >
              {tab === "thread" ? t("files.thisThread") : t("files.allFiles")}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && !data && <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("files.loading")}</div>}
        {error && <div className="px-4 py-3 text-[13px] text-danger">{error}</div>}
        {external && (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">{t("files.external", { path: data?.cwd ?? "" })}</div>
        )}
        {unsupported && <div className="px-4 py-6 text-[13px] text-ink-secondary">{t("files.ownerless")}</div>}
        {!loading && !error && !external && !unsupported && files.length === 0 && (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">{view === "thread" ? t("files.emptyThread") : t("files.emptyAll")}</div>
        )}
        {files.map((file) => {
          const active = selected?.fileId === file.fileId;
          return (
            <div key={file.fileId} className={cn("group/file flex items-center gap-2 px-3", active ? "bg-selected" : "hover:bg-menu-hover")}>
              <button type="button" onClick={() => choose(file)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-2 text-left">
                <FileIcon file={file} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{file.name}</span>
                  <span className="block truncate text-[11px] text-ink-tertiary">
                    {view === "all" && `${file.botName ?? file.botId ?? t("files.deletedBot")} / ${file.threadTitle ?? (file.deletedThread ? t("files.deletedThread") : file.threadId ?? "")} · `}
                    {formatBytes(file.bytes)} · {formatModified(file.mtimeMs)}
                  </span>
                </span>
                {active ? <ChevronLeft size={14} className="shrink-0 text-ink-secondary" /> : null}
              </button>
              <button type="button" onClick={() => download(file)} aria-label={t("files.download")} title={t("files.download")} className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover/file:opacity-100 focus-visible:opacity-100 touch:opacity-70">
                <Download size={14} />
              </button>
              <button type="button" onClick={() => setPendingDelete(file)} aria-label={t("files.delete")} title={t("files.delete")} className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger group-hover/file:opacity-100 focus-visible:opacity-100 touch:opacity-70">
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
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
