// Files: the read-only thread library plus the one UI deletion route.
//
// Paths are never accepted from a client. A thread route names a bot and
// thread; the record routes name a file id. Ownership is checked here because
// /api/files is not one of the path subjects the global visibility pass knows.
import { resolve } from "node:path";
import { deleteFile, listAllFiles, listThreadFiles, managedFilesRoot, managedThreadRoot, resolveFile } from "../file-library.ts";
import { fileRecordById } from "../message-db.ts";
import { messageFileDisposition, openMessageFile } from "../message-file.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface FileBot {
  id: string;
  name: string;
  ownerUserId?: string;
  cwd?: string | null;
}

interface FileTask {
  title?: string;
  cwd?: string | null;
}

export interface FilesRouteDeps {
  bot(id: string): FileBot | null | undefined;
  taskByThread(botId: string, threadId: string): FileTask | undefined;
  /** The same visibility a member gets on a bot route. Undefined in tests. */
  canSeeBot?(auth: RequestAuth, botId: string): boolean;
}

function sessionOwner(auth: RequestAuth): string | null {
  return auth.kind === "session" && typeof auth.session.userId === "string" && auth.session.userId
    ? auth.session.userId.toLowerCase()
    : null;
}

function canReadOwner(auth: RequestAuth, ownerUserId: string): boolean {
  if (auth.kind === "loopback") return true;
  return sessionOwner(auth) === ownerUserId;
}

function threadOwner(auth: RequestAuth, bot: FileBot): string | null {
  const owner = bot.ownerUserId?.toLowerCase();
  if (!owner) return null;
  const session = sessionOwner(auth);
  return session && session !== owner ? null : owner;
}

function externalCwd(bot: FileBot, task: FileTask | undefined, managed: string): string | null | undefined {
  const effective = task?.cwd !== undefined ? task.cwd : bot.cwd;
  if (effective === undefined) return undefined;
  if (effective === null) return null;
  try {
    return resolve(effective) === resolve(managed) ? undefined : effective;
  } catch {
    return effective;
  }
}

export function createFilesRoutes(deps: FilesRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json: respond }) => {
    let m: RegExpMatchArray | null = null;

    m = path.match(/^\/api\/bots\/([\w-]+)\/threads\/([\w-]+)\/files$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]!);
      const task = bot ? deps.taskByThread(bot.id, m[2]!) : undefined;
      if (!bot || !task) return respond(res, 404, { error: "no such conversation" });
      const owner = threadOwner(auth, bot);
      if (!owner) {
        if (auth.kind === "session" && sessionOwner(auth) !== bot.ownerUserId?.toLowerCase()) {
          return respond(res, 404, { error: "no such conversation" });
        }
        return respond(res, 200, { files: [], truncated: false, unsupported: "ownerless" });
      }
      const managed = managedThreadRoot(owner, bot.id, m[2]!);
      const external = externalCwd(bot, task, managed);
      if (external !== undefined) {
        return respond(res, 200, { files: [], truncated: false, external: true, cwd: external });
      }
      return respond(res, 200, { ...listThreadFiles(owner, bot.id, m[2]!), external: false });
    }

    if (method === "GET" && path === "/api/files") {
      const hintedBot = url.searchParams.get("botId")?.trim();
      const hinted = hintedBot ? deps.bot(hintedBot) : undefined;
      const owner = sessionOwner(auth) ?? (auth.kind === "loopback" ? hinted?.ownerUserId?.toLowerCase() : null);
      if (!owner) {
        return respond(res, 400, { error: "botId is required to choose whose files to list" });
      }
      const listed = listAllFiles(owner);
      const files = listed.files.filter((file) => !file.botId || !deps.canSeeBot || deps.canSeeBot(auth, file.botId)).map((file) => {
        const bot = file.botId ? deps.bot(file.botId) : undefined;
        const task = file.botId && file.threadId ? deps.taskByThread(file.botId, file.threadId) : undefined;
        return {
          ...file,
          ...(bot?.name ? { botName: bot.name } : {}),
          ...(task?.title ? { threadTitle: task.title } : {}),
          ...(!task?.title && file.threadId ? { deletedThread: true } : {}),
        };
      });
      return respond(res, 200, { files, truncated: listed.truncated });
    }

    m = path.match(/^\/api\/files\/(file_[a-z0-9]{6,32})$/);
    if (m && method === "GET") {
      const resolved = resolveFileForAuth(auth, m[1]!);
      if (!resolved) return respond(res, 404, { error: "no such file" });
      return respond(res, 200, fileMetadata(resolved));
    }
    if (m && method === "DELETE") {
      const record = resolveFileForAuth(auth, m[1]!);
      if (!record) return respond(res, 404, { error: "no such file" });
      const owner = auth.kind === "loopback" ? record.record.ownerUserId : sessionOwner(auth);
      if (!owner) return respond(res, 404, { error: "no such file" });
      const deleted = deleteFile(owner, m[1]!);
      if (!deleted.ok) return respond(res, deleted.status, { error: deleted.error });
      return respond(res, 200, { ok: true, name: deleted.name });
    }

    m = path.match(/^\/api\/files\/(file_[a-z0-9]{6,32})\/content$/);
    if (m && method === "GET") {
      const resolved = resolveFileForAuth(auth, m[1]!);
      if (!resolved) return respond(res, 404, { error: "no such file" });
      let file;
      try {
        file = await openMessageFile(resolved.record.path, [managedFilesRoot(resolved.record.ownerUserId)]);
      } catch {
        return respond(res, 404, { error: "that file is unavailable" });
      }
      const download = url.searchParams.get("download") === "1";
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        "content-disposition": download ? messageFileDisposition(file.name) : "inline",
        "cache-control": "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        pragma: "no-cache",
        vary: "Authorization",
        "x-content-type-options": "nosniff",
      });
      if (file.bytes === 0) {
        await file.handle.close();
        res.end();
        return;
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    return PASS;
  };

  function resolveFileForAuth(auth: RequestAuth, fileId: string) {
    const record = resolveFileById(fileId);
    if (!record || !canReadOwner(auth, record.record.ownerUserId)) return null;
    if (record.record.botId && deps.canSeeBot && !deps.canSeeBot(auth, record.record.botId)) return null;
    return record;
  }
}

/** Look up without knowing the owner first, then the caller rejects a
 * mismatched session. This keeps the id path simple while never crossing a
 * user boundary. */
function resolveFileById(fileId: string) {
  // resolveFile needs an owner; the database row carries it, so read it once
  // through the shared library and verify the real path under that owner.
  const record = fileRecordById(fileId);
  if (!record) return null;
  return resolveFile(record.ownerUserId, fileId);
}

function fileMetadata(file: NonNullable<ReturnType<typeof resolveFile>>) {
  return {
    fileId: file.record.id,
    name: file.name,
    bytes: file.bytes,
    mtimeMs: file.mtimeMs,
    mime: file.mime,
    ...(file.record.botId ? { botId: file.record.botId } : {}),
    ...(file.record.threadId ? { threadId: file.record.threadId } : {}),
  };
}
