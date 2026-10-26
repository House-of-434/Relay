/** Durable, per-turn outbox for mirrored routed-mail replies.
 *
 * A row is created at settle, sent from the mailbox monitor's minute tick, and
 * retried with a lease. Every transition is conditional on the current claim
 * id inside an IMMEDIATE transaction, so two drains (or an old worker whose
 * lease expired) cannot both complete the same row. Ambiguous Gmail outcomes
 * are reconciled by the deterministic RFC Message-ID before a resend; delivery
 * is at-least-once, never exactly-once. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { runCommand } from "./commands.ts";
import { listCommandReceipts, mutateCommandReceipt } from "./message-db.ts";

export interface MailReplyAttachmentRef {
  path: string;
  filename: string;
  mimeType: string;
}

export type MailReplyState = "pending" | "sending" | "sent" | "failed" | "dead";

export interface MailReplyRow {
  state: MailReplyState;
  /** Stable settle time; the `at` column changes on every claim. */
  createdAt: number;
  turnId: string;
  threadId: string;
  gmailThreadId: string;
  sourceMessageId: string;
  to: string;
  subject: string;
  body: string;
  /** Rendered HTML alternative, persisted with the row. */
  html?: string;
  /** Deterministic RFC 5322 Message-ID, persisted before the first send. */
  messageId: string;
  attachments: MailReplyAttachmentRef[];
  attempts: number;
  nextAt?: number;
  claimId?: string;
  leaseUntil?: number;
  reconcile?: boolean;
  ambiguous?: number;
  sentId?: string | null;
  sentThreadId?: string | null;
  error?: string;
}

export interface MailReplySent {
  sentId: string | null;
  gmailThreadId: string | null;
}

export interface MailReplySkipped {
  skipped: true;
  reason: string;
  permanent: boolean;
}

export interface MailReplySendInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  gmailThreadId: string;
  sourceMessageId: string;
  messageId: string;
  attachments: Array<{ filename: string; mimeType: string; data: string }>;
}

export interface DrainRoutedRepliesDeps {
  send: (input: MailReplySendInput) => Promise<MailReplySent | MailReplySkipped | null>;
  /** True when the relay mailbox already contains this RFC Message-ID. */
  findSent: (messageId: string) => Promise<boolean>;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export interface CreateMailReplyInput {
  turnId: string;
  threadId: string;
  gmailThreadId: string;
  sourceMessageId: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  messageId: string;
  attachments: MailReplyAttachmentRef[];
}

/** The MVP reply-eligibility rule. It deliberately keeps the 30-minute
 * unattended window: a turn that finishes after it is not emailed. The
 * send-authorization rule is separate and lives on the turn capability. */
export function shouldMirrorRoutedTurn(input: {
  mailRouted: boolean;
  ok: boolean;
  completedTurnId?: string;
  unattended: boolean;
}): boolean {
  return input.mailRouted && input.ok && Boolean(input.completedTurnId) && input.unattended;
}

const KIND = "gmail.reply";
const MAX_ATTEMPTS = 5;
/** Must exceed the BFF send timeout; a stale lease is reclaimed by the next
 * drain and reconciled before any resend. */
const LEASE_MS = 2 * 60_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

function errorStatus(error: unknown): number {
  const value = (error as { status?: unknown } | null)?.status;
  return typeof value === "number" ? value : 0;
}

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)]!;
}

const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "bat", "cmd", "com", "scr", "msi", "ps1", "ps2", "psm1", "sh", "bash", "zsh", "dll", "jar", "app", "dmg", "pkg",
  "vbs", "vb", "wsf", "lnk", "iso", "apk", "deb", "rpm", "reg", "hta", "cpl", "msc", "chm",
  "js", "jse", "vbe", "wsh", "wsc", "sct", "pif",
]);
const BLOCKED_ATTACHMENT_MIME = /^(?:application\/(?:x-msdownload|x-executable|x-sh|x-msdos-program|vnd\.microsoft\.portable-executable|x-apple-diskimage|java-archive|javascript|x-javascript|x-vbscript)|text\/(?:javascript|x-vbscript))$/i;

function attachmentExtension(filename: string): string {
  const normalized = filename.trim().replace(/[. ]+$/, "").toLowerCase();
  if (!normalized.includes(".")) return "";
  return normalized.split(".").pop()?.trim() ?? "";
}

function isBlockedAttachment(filename: string, mimeType: string): boolean {
  const extension = attachmentExtension(filename);
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(extension)) return true;
  if (BLOCKED_ATTACHMENT_MIME.test(mimeType.trim())) return true;
  if (!extension) {
    const mime = mimeType.trim().toLowerCase();
    if (mime === "" || mime === "application/octet-stream") return true;
  }
  return false;
}

function logDead(
  log: (event: Record<string, unknown>) => void,
  claimed: MailReplyRow,
  error: string,
): void {
  log({
    event: "mail-reply.dead",
    turnId: claimed.turnId,
    attempts: claimed.attempts,
    ambiguous: claimed.ambiguous ?? 0,
    error: error.slice(0, 200),
  });
}

function parseRow(stored: { result: string }): MailReplyRow | undefined {
  try {
    const row = JSON.parse(stored.result) as Partial<MailReplyRow> | null;
    if (!row || typeof row !== "object" || typeof row.turnId !== "string" ||
        typeof row.gmailThreadId !== "string" || typeof row.state !== "string") return undefined;
    return row as MailReplyRow;
  } catch {
    return undefined;
  }
}

function listRows(): MailReplyRow[] {
  return listCommandReceipts(KIND).flatMap((stored) => {
    const row = parseRow(stored);
    return row ? [row] : [];
  });
}

export function createMailReplyRow(input: CreateMailReplyInput): void {
  runCommand({ kind: KIND, key: input.turnId }, () => {
    const row: MailReplyRow = {
      ...input,
      state: "pending",
      createdAt: Date.now(),
      attempts: 0,
    };
    return row;
  });
}

/** Claim the next due row for one turn. Returns undefined when another worker
 * holds it, it is terminal, or an earlier reply for the same Gmail thread has
 * not reached a terminal state. */
function claimRow(turnId: string, now: number): MailReplyRow | undefined {
  let claimed: MailReplyRow | undefined;
  const ok = mutateCommandReceipt(KIND, turnId, (storedRows) => {
    const rows = storedRows.flatMap((stored) => {
      const row = parseRow(stored);
      return row ? [row] : [];
    });
    const current = rows.find((row) => row.turnId === turnId);
    if (!current || current.state === "sent" || current.state === "dead") return null;
    if (current.state === "pending" ||
        (current.state === "failed" && (current.nextAt ?? 0) <= now) ||
        (current.state === "sending" && (current.leaseUntil ?? 0) <= now)) {
      const earlier = rows.some((row) =>
        row.gmailThreadId === current.gmailThreadId &&
        (row.createdAt < current.createdAt ||
          (row.createdAt === current.createdAt && row.turnId < current.turnId)) &&
        row.state !== "sent" && row.state !== "dead");
      if (earlier) return null;
      const claimId = randomUUID();
      const next: MailReplyRow = {
        ...current,
        state: "sending",
        claimId,
        leaseUntil: now + LEASE_MS,
        attempts: current.attempts + 1,
        ambiguous: current.state === "sending" ? (current.ambiguous ?? 0) + 1 : current.ambiguous,
        reconcile: current.state === "sending" ? true : current.reconcile === true,
      };
      claimed = next;
      return JSON.stringify(next);
    }
    return null;
  }, now);
  return ok ? claimed : undefined;
}

/** Every completion is conditional on this exact claim id. A worker whose
 * lease was reclaimed cannot overwrite the new owner's state. */
function updateClaimed(
  row: MailReplyRow,
  now: number,
  update: (current: MailReplyRow) => MailReplyRow | null,
): boolean {
  if (!row.claimId) return false;
  let changed = false;
  mutateCommandReceipt(KIND, row.turnId, (storedRows) => {
    const rows = storedRows.flatMap((stored) => {
      const value = parseRow(stored);
      return value ? [value] : [];
    });
    const current = rows.find((value) => value.turnId === row.turnId);
    if (!current || current.state !== "sending" || current.claimId !== row.claimId) return null;
    const next = update(current);
    if (!next) return null;
    changed = true;
    return JSON.stringify(next);
  }, now);
  return changed;
}

function markSent(row: MailReplyRow, sent: MailReplySent, now: number): boolean {
  return updateClaimed(row, now, (current) => ({
    ...current,
    state: "sent",
    sentId: sent.sentId,
    sentThreadId: sent.gmailThreadId,
    claimId: undefined,
    leaseUntil: undefined,
    nextAt: undefined,
    reconcile: false,
    error: undefined,
  }));
}

function markFailed(row: MailReplyRow, error: string, permanent: boolean, now: number): boolean {
  const dead = permanent || row.attempts >= MAX_ATTEMPTS;
  return updateClaimed(row, now, (current) => ({
    ...current,
    state: dead ? "dead" : "failed",
    leaseUntil: undefined,
    nextAt: dead ? undefined : now + backoffFor(row.attempts),
    reconcile: permanent ? false : true,
    error: error.slice(0, 200),
  }));
}

export async function drainRoutedReplies(deps: DrainRoutedRepliesDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const rows = listRows().sort((a, b) =>
    a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId));
  const groups = new Map<string, MailReplyRow[]>();
  for (const row of rows) {
    const group = groups.get(row.gmailThreadId) ?? [];
    group.push(row);
    groups.set(row.gmailThreadId, group);
  }

  for (const group of groups.values()) {
    for (const row of group) {
      if (row.state === "sent" || row.state === "dead") continue;
      if (row.state === "sending" && (row.leaseUntil ?? 0) > now) break;
      if (row.state === "failed" && (row.nextAt ?? 0) > now) break;

      const claimed = claimRow(row.turnId, now);
      if (!claimed) break; // another worker or an earlier reply; later rows wait

      if (claimed.reconcile) {
        let found = false;
        try {
          found = await deps.findSent(claimed.messageId);
        } catch (error) {
          deps.log({ event: "mail-reply.reconcile-failed", turnId: claimed.turnId, error: errorText(error) });
        }
        if (found) {
          markSent(claimed, { sentId: null, gmailThreadId: claimed.gmailThreadId }, now);
          deps.log({ event: "mail-reply.reconciled", turnId: claimed.turnId });
          continue;
        }
      }

      const attachments: Array<{ filename: string; mimeType: string; data: string }> = [];
      const dropped: MailReplyAttachmentRef[] = [];
      const unreadable: MailReplyAttachmentRef[] = [];
      let total = 0;
      for (const attachment of claimed.attachments) {
        if (isBlockedAttachment(attachment.filename, attachment.mimeType)) {
          dropped.push(attachment);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(attachment.path);
        } catch {
          unreadable.push(attachment);
          continue;
        }
        if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
          dropped.push(attachment);
          continue;
        }
        if (total + bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) {
          dropped.push(attachment);
          continue;
        }
        total += bytes.length;
        attachments.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          data: bytes.toString("base64"),
        });
      }
      if (unreadable.length) {
        const error = "an attachment could not be read";
        markFailed(claimed, error, false, now);
        if (claimed.attempts >= MAX_ATTEMPTS) logDead(deps.log, claimed, error);
        break;
      }
      const droppedNames = dropped.map((attachment) => attachment.filename).join(", ").slice(0, 500);
      const body = dropped.length
        ? `${claimed.body}\n\n[Relay could not include: ${droppedNames}]`
        : claimed.body;
      let html = claimed.html;
      if (dropped.length && html) {
        const note = `<p>[Relay could not include: ${escapeHtml(droppedNames)}]</p>`;
        html = /<\/div>\s*$/.test(html) ? html.replace(/<\/div>\s*$/, `${note}</div>`) : `${html}${note}`;
      }

      try {
        const sent = await deps.send({
          to: claimed.to,
          subject: claimed.subject,
          body,
          ...(html ? { html } : {}),
          gmailThreadId: claimed.gmailThreadId,
          sourceMessageId: claimed.sourceMessageId,
          messageId: claimed.messageId,
          attachments,
        });
        if (!sent || (typeof sent === "object" && "skipped" in sent)) {
          const skipped = typeof sent === "object" && sent !== null && "skipped" in sent
            ? sent as MailReplySkipped
            : null;
          const reason = skipped?.reason ?? "the mailbox service did not send the reply";
          const permanent = skipped?.permanent ?? false;
          deps.log({
            event: "mail-reply.skipped",
            turnId: claimed.turnId,
            attempts: claimed.attempts,
            reason: reason.slice(0, 200),
          });
          markFailed(claimed, reason, permanent, now);
          if (permanent || claimed.attempts >= MAX_ATTEMPTS) logDead(deps.log, claimed, reason);
          break;
        }
        if (dropped.length) {
          deps.log({
            event: "mail-reply.attachments-dropped",
            turnId: claimed.turnId,
            paths: dropped.map((attachment) => attachment.path),
          });
        }
        markSent(claimed, sent, now);
        continue;
      } catch (error) {
        const status = errorStatus(error);
        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
        markFailed(claimed, errorText(error), permanent, now);
        if (permanent || claimed.attempts >= MAX_ATTEMPTS) logDead(deps.log, claimed, errorText(error));
        break;
      }
    }
  }
}
