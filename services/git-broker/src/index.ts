import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

import { gitReadAuthorization, verifyPublishAuthorization } from "./authorization.ts";

const PORT = Number(process.env.RELAY_GIT_BROKER_PORT ?? 8792);
const HOST = process.env.RELAY_GIT_BROKER_HOST ?? "127.0.0.1";
const PUBLIC_URL = process.env.RELAY_GIT_BROKER_PUBLIC_URL?.trim() || `http://${HOST}:${PORT}`;
const CAPABILITY = process.env.RELAY_BFF_CAPABILITY;
const BFF_URL = process.env.RELAY_BFF_INTERNAL_URL?.trim() || "http://127.0.0.1:8798";
const BFF_CAPABILITY = process.env.RELAY_BFF_CAPABILITY;
const ACTOR_SECRET = process.env.RELAY_TOOL_ACTOR_SECRET;

const SESSION_TTL_MS = 60 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_ATTACHMENT = 100 * 1024 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface Session {
  token: string;
  actorAssertion: string;
  workspace: string;
  userId: string;
  expiresAt: number;
}

interface PublishResult {
  ok: true;
  prUrl: string;
  branch: string;
  commit: string;
}

const sessions = new Map<string, Session>();
const usedNonces = new Map<string, number>();

function log(message: string): void {
  console.log(`[git-broker] ${message}`);
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function constantEqual(left: string, right: string | undefined): boolean {
  if (typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireCapability(req: IncomingMessage): void {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
  if (!match || !constantEqual(match[1]!, CAPABILITY)) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function userConfigError(): void {
  if (!CAPABILITY || Buffer.byteLength(CAPABILITY) < 32) throw new Error("RELAY_BFF_CAPABILITY must be at least 32 bytes");
  if (!BFF_CAPABILITY || Buffer.byteLength(BFF_CAPABILITY) < 32) throw new Error("RELAY_BFF_CAPABILITY must be at least 32 bytes");
  if (!ACTOR_SECRET || Buffer.byteLength(ACTOR_SECRET) < 32) throw new Error("RELAY_TOOL_ACTOR_SECRET must be at least 32 bytes");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep);
}

function canonicalWorkspace(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) fail("invalid workspace");
  const exact = resolve(value);
  if (exact === resolve("/") || exact === resolve(process.env.HOME ?? "/")) fail("invalid workspace");
  return exact;
}

async function userToken(actorAssertion: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/internal/github/user-token", BFF_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${BFF_CAPABILITY}`,
        "x-relay-actor-user": actorAssertion,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw Object.assign(new Error("GitHub credential service is unreachable"), { status: 502 });
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw Object.assign(new Error(typeof body.error === "string" ? body.error : "GitHub is not connected"), { status: response.status });
  }
  const body = await response.json() as { accessToken?: unknown };
  if (typeof body.accessToken !== "string" || !body.accessToken) {
    throw Object.assign(new Error("GitHub credential service returned no token"), { status: 502 });
  }
  return body.accessToken;
}

function prune(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [nonce, at] of usedNonces) {
    if (at + SESSION_TTL_MS <= now) usedNonces.delete(nonce);
  }
}

function repoParts(repo: string): [string, string] {
  if (!REPO_PATTERN.test(repo)) fail("invalid repository");
  const [owner, name] = repo.split("/") as [string, string];
  return [owner, name];
}

function githubUrl(repo: string): string {
  const [owner, name] = repoParts(repo);
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
}

function repoPathFor(workspace: string, repo: string): string {
  const [owner, name] = repoParts(repo);
  const suffix = createHash("sha256").update(`${owner}/${name}`.toLowerCase()).digest("hex").slice(0, 8);
  return join(workspace, "repos", `${owner}__${name}__${suffix}`);
}

function checkedRepoPath(workspace: string, authPath: string, repo: string): string {
  const expected = repoPathFor(workspace, repo);
  const exact = resolve(workspace, authPath);
  if (exact !== expected) fail("publish path does not match the repository");
  if (!inside(workspace, exact)) fail("publish path escapes the workspace");
  return exact;
}

async function ensureRealDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    fail("repository workspace is unavailable");
  }
  if (!info.isDirectory()) fail("repository workspace is unavailable");
}

function run(command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    const timer = setTimeout(kill, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => finish({ code, stdout, stderr }));
  });
}

async function git(args: string[], cwd: string, env: Record<string, string>, timeoutMs = GIT_TIMEOUT_MS) {
  const result = await run("git", args, { cwd, env, timeoutMs });
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr.trim() || `git exited with ${result.code ?? "no code"}`), { status: 502 });
  }
  return result.stdout.trim();
}

async function askPassEnvironment(token: string): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "relay-git-"));
  const script = join(directory, "askpass.sh");
  await writeFile(script, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  Username*) printf '%s' 'x-access-token' ;;",
    "  *) printf '%s' \"$RELAY_GH_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  return {
    env: {
      GIT_ASKPASS: script,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      RELAY_GH_TOKEN: token,
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function remoteBranchHead(repo: string, branch: string, token: string): Promise<string | null> {
  const [owner, name] = repoParts(repo);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(branch)}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`GitHub refused the branch check (${response.status})`), { status: 502 });
  }
  const body = await response.json() as { object?: { sha?: unknown } };
  return typeof body.object?.sha === "string" ? body.object.sha : null;
}

async function repoId(repo: string, token: string): Promise<number | undefined> {
  const [owner, name] = repoParts(repo);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const body = await response.json() as { id?: unknown };
  return typeof body.id === "number" ? body.id : undefined;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

async function uploadAttachment(input: { workspace: string; path: string; repo: string; token: string }): Promise<string | undefined> {
  const absolute = resolve(input.workspace, input.path);
  if (!inside(input.workspace, absolute)) return undefined;
  let info;
  try { info = await stat(absolute); } catch { return undefined; }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT) return undefined;
  const mime = MIME[extname(absolute).toLowerCase()];
  if (!mime) return undefined;
  const id = await repoId(input.repo, input.token);
  if (!id) return undefined;
  const name = basename(absolute);
  const query = new URLSearchParams({ name, content_type: mime, repository_id: String(id) });
  let response: Response;
  try {
    response = await fetch(`https://uploads.github.com/user-attachments/assets?${query.toString()}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
        "content-type": mime,
      },
      body: await readFile(absolute),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return undefined; }
  const body = await response.json() as { url?: unknown };
  return typeof body.url === "string" && body.url.startsWith("https://github.com/user-attachments/") ? body.url : undefined;
}

async function createPullRequest(input: {
  repo: string;
  branch: string;
  commit: string;
  title: string;
  body: string;
  workspace: string;
  attachments: string[];
  token: string;
}): Promise<string> {
  const [owner] = repoParts(input.repo);
  let body = input.body;
  const visual: string[] = [];
  for (const attachment of input.attachments) {
    const url = await uploadAttachment({ workspace: input.workspace, path: attachment, repo: input.repo, token: input.token });
    if (url) visual.push(`![${basename(attachment)}](${url})`);
  }
  if (visual.length) {
    body = `${body.trim()}\n\n## Visual review\n\n${visual.join("\n\n")}\n`;
  }
  const create = async (): Promise<Response> => fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.repo.split("/")[1]!)}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ title: input.title, body, head: input.branch, base: "main" }),
    signal: AbortSignal.timeout(30_000),
  });
  let response = await create();
  if (response.status === 422) {
    await response.body?.cancel().catch(() => {});
    const lookup = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.repo.split("/")[1]!)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
    if (lookup.ok) {
      const existing = await lookup.json() as Array<{ html_url?: unknown }>;
      const found = existing.find((entry): entry is { html_url: string } => typeof entry.html_url === "string");
      if (found) return found.html_url;
    }
    response = await create();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`GitHub refused the pull request (${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`), { status: 502 });
  }
  const bodyJson = await response.json() as { html_url?: unknown };
  if (typeof bodyJson.html_url !== "string") throw Object.assign(new Error("GitHub returned no pull-request URL"), { status: 502 });
  return bodyJson.html_url;
}

async function publish(value: unknown): Promise<PublishResult> {
  const auth = verifyPublishAuthorization(value, ACTOR_SECRET);
  if (usedNonces.has(auth.nonce)) fail("publish authorization was already used");
  const session = sessions.get(String((value as { sessionToken?: unknown }).sessionToken ?? ""));
  if (!session || session.expiresAt <= Date.now()) fail("publish session is unavailable");
  if (session.userId !== auth.userId) fail("publish session does not belong to this user");
  const workspace = canonicalWorkspace(session.workspace);
  const repoPath = checkedRepoPath(workspace, auth.path, auth.repo);
  await ensureRealDirectory(repoPath);
  const realRepo = await realpath(repoPath);
  if (!inside(workspace, realRepo)) fail("repository workspace escapes the conversation");
  const token = await userToken(session.actorAssertion);
  const askpass = await askPassEnvironment(token);
  try {
    const head = await git(["-C", repoPath, "rev-parse", "HEAD"], repoPath, askpass.env);
    if (head !== auth.commit) fail("the approved commit is not the current HEAD");
    const existing = await remoteBranchHead(auth.repo, auth.branch, token);
    if (existing && existing !== auth.commit) fail("the remote branch already exists with different changes");
    if (!existing) {
      await git([
        "-C", repoPath, "-c", "core.hooksPath=/dev/null",
        "push", githubUrl(auth.repo), `${auth.commit}:refs/heads/${auth.branch}`,
      ], repoPath, askpass.env);
    }
    const prUrl = await createPullRequest({
      repo: auth.repo,
      branch: auth.branch,
      commit: auth.commit,
      title: auth.title,
      body: auth.body,
      workspace,
      attachments: auth.attachments,
      token,
    });
    usedNonces.set(auth.nonce, Date.now());
    return { ok: true, prUrl, branch: auth.branch, commit: auth.commit };
  } finally {
    await askpass.cleanup();
  }
}

function protocolResponse(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

async function readProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "git" || parts.length < 5) return protocolResponse(res, 404, "not found");
  const session = sessions.get(parts[1]!);
  if (!session || session.expiresAt <= Date.now()) return protocolResponse(res, 401, "git session expired");
  const owner = parts[2]!;
  const repo = parts[3]!.replace(/\.git$/, "");
  const action = parts.slice(4).join("/");
  if (!REPO_PATTERN.test(`${owner}/${repo}`)) return protocolResponse(res, 400, "invalid repository");
  if (action !== "info/refs" && action !== "git-upload-pack") {
    return protocolResponse(res, 403, "publishing requires approval inside Relay");
  }
  const service = action === "info/refs" ? url.searchParams.get("service") : "git-upload-pack";
  if (service !== "git-upload-pack") return protocolResponse(res, 403, "publishing requires approval inside Relay");
  const token = await userToken(session.actorAssertion);
  const target = action === "info/refs"
    ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/refs?service=git-upload-pack`
    : `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-upload-pack`;
  const chunks: Buffer[] = [];
  let size = 0;
  if (req.method === "POST") {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY) return protocolResponse(res, 413, "request too large");
      chunks.push(buffer);
    }
  }
  const authorization = gitReadAuthorization(token);
  let response: Response;
  try {
    response = await fetch(target, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        authorization,
        accept: req.headers.accept ?? "*/*",
        ...(req.headers["git-protocol"] ? { "git-protocol": String(req.headers["git-protocol"]) } : {}),
        ...(req.method === "POST" ? { "content-type": String(req.headers["content-type"] ?? "application/x-git-upload-pack-request") } : {}),
      },
      ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return protocolResponse(res, 502, "GitHub is unreachable");
  }
  res.statusCode = response.status;
  const contentType = response.headers.get("content-type");
  if (contentType) res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body as never).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  if (req.method === "POST" && url.pathname === "/internal/session") {
    requireCapability(req);
    const body = await readJson(req) as { actorAssertion?: unknown; workspace?: unknown };
    if (typeof body.actorAssertion !== "string" || body.actorAssertion.length > 2048) fail("invalid actor assertion");
    const workspace = canonicalWorkspace(body.workspace);
    const token = randomBytes(32).toString("base64url");
    const userId = JSON.parse(body.actorAssertion).userId as string;
    sessions.set(token, {
      token,
      actorAssertion: body.actorAssertion,
      workspace,
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    json(res, 200, { token, url: `${PUBLIC_URL.replace(/\/$/, "")}/git/${token}`, expiresAt: Date.now() + SESSION_TTL_MS });
    return;
  }
  if (req.method === "POST" && url.pathname === "/internal/publish") {
    requireCapability(req);
    const body = await readJson(req);
    const result = await publish(body);
    json(res, 200, result);
    return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" || req.method === "POST") {
    await readProxy(req, res, url);
    return;
  }
  protocolResponse(res, 405, "method not allowed");
}

userConfigError();
const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    log(`${req.method ?? "?"} ${req.url ?? "?"} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : "request failed" });
    else res.end();
  });
});
setInterval(prune, 60_000).unref();
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
});

