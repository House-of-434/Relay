import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { userThreadsDir } from "../user-paths.ts";
import { createFilesRoutes } from "./files.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const bots: Record<string, { id: string; name: string; ownerUserId?: string; cwd?: string | null }> = {};
const tasks: Record<string, { title?: string; cwd?: string | null }> = {};

async function serve(): Promise<string> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes([createFilesRoutes({
        bot: (id) => bots[id],
        taskByThread: (botId, threadId) => tasks[`${botId}:${threadId}`],
      })], {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function managedThread(owner: string, botId: string, threadId: string): string {
  const dir = join(userThreadsDir(owner), botId, threadId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the Files route family", () => {
  it("lists managed thread files with stable ids and hides dotfiles and dependency folders", async () => {
    const owner = randomUUID();
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    bots[botId] = { id: botId, name: "Scout", ownerUserId: owner };
    tasks[`${botId}:${threadId}`] = { title: "Charts" };
    const dir = managedThread(owner, botId, threadId);
    writeFileSync(join(dir, "chart.png"), "png");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "hidden.js"), "x");
    writeFileSync(join(dir, ".secret"), "x");
    try { symlinkSync(join(dir, "chart.png"), join(dir, "linked.png")); } catch {}

    const base = await serve();
    const first = await fetch(`${base}/api/bots/${botId}/threads/${threadId}/files`);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { files: Array<{ fileId: string; name: string }>; external: boolean };
    expect(firstBody.external).toBe(false);
    expect(firstBody.files.map((file) => file.name)).toEqual(["chart.png"]);
    expect(firstBody.files[0]!.fileId).toMatch(/^file_[a-z0-9]{6,32}$/);

    const again = await (await fetch(`${base}/api/bots/${botId}/threads/${threadId}/files`)).json() as { files: Array<{ fileId: string }> };
    expect(again.files[0]!.fileId).toBe(firstBody.files[0]!.fileId);

    const content = await fetch(`${base}/api/files/${firstBody.files[0]!.fileId}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("png");
  });

  it("lists All Files with bot and thread names, including a deleted thread", async () => {
    const owner = randomUUID();
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const liveThread = `thread-${randomUUID().slice(0, 8)}`;
    const goneThread = `thread-${randomUUID().slice(0, 8)}`;
    bots[botId] = { id: botId, name: "Mercury", ownerUserId: owner };
    tasks[`${botId}:${liveThread}`] = { title: "Live", cwd: null };
    writeFileSync(join(managedThread(owner, botId, liveThread), "a.txt"), "a");
    writeFileSync(join(managedThread(owner, botId, goneThread), "b.txt"), "b");

    const base = await serve();
    const response = await fetch(`${base}/api/files?botId=${botId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { files: Array<{ name: string; botName?: string; threadTitle?: string; deletedThread?: boolean }> };
    expect(body.files.map((file) => file.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect(body.files.find((file) => file.name === "a.txt")?.threadTitle).toBe("Live");
    expect(body.files.find((file) => file.name === "b.txt")?.deletedThread).toBe(true);
  });

  it("returns an external empty state instead of listing a project folder", async () => {
    const owner = randomUUID();
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    bots[botId] = { id: botId, name: "Scout", ownerUserId: owner, cwd: "/tmp/project" };
    tasks[`${botId}:${threadId}`] = { title: "Project", cwd: "/tmp/project" };
    const base = await serve();
    const response = await fetch(`${base}/api/bots/${botId}/threads/${threadId}/files`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ files: [], external: true });
  });

  it("deletes a managed file and its id, but refuses a missing id", async () => {
    const owner = randomUUID();
    const botId = `bot-${randomUUID().slice(0, 8)}`;
    const threadId = `thread-${randomUUID().slice(0, 8)}`;
    bots[botId] = { id: botId, name: "Scout", ownerUserId: owner };
    tasks[`${botId}:${threadId}`] = { title: "Charts" };
    const dir = managedThread(owner, botId, threadId);
    const path = join(dir, "chart.png");
    writeFileSync(path, "png");

    const base = await serve();
    const listed = await (await fetch(`${base}/api/bots/${botId}/threads/${threadId}/files`)).json() as { files: Array<{ fileId: string }> };
    const fileId = listed.files[0]!.fileId;
    const deleted = await fetch(`${base}/api/files/${fileId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, name: "chart.png" });
    expect(await (await fetch(`${base}/api/files/${fileId}`)).status).toBe(404);
    expect(existsSync(path)).toBe(false);
  });
});
