import { createHash } from "node:crypto";

import type { Agent } from "../domain/permissions.js";
import type { RelayDatabase } from "../infra/database.js";

export interface ReadAudit {
  table: string;
  /** Validated select list. */
  select: string[];
  /** Filter KEYS only, never values (values can be PII). */
  filterKeys: string[];
  rowCount: number;
  flagged: boolean;
}

/** A bulk PII pull stands out in review: `select` names `email` and the
 * result exceeds this many rows. The flag shows up as `logs.tool_calls.flagged`. */
export const BULK_READ_ROW_THRESHOLD = 50;

export function auditRead(table: string, select: string[], filterKeys: string[], rowCount: number): ReadAudit {
  return {
    table,
    select,
    filterKeys,
    rowCount,
    flagged: select.includes("email") && rowCount > BULK_READ_ROW_THRESHOLD,
  };
}

export interface ToolCallOutcome {
  tool: string;
  /** sha256 of the call's arguments — never the arguments themselves. */
  argsHash: string;
  ms: number;
  error: string | null;
  read?: ReadAudit | null;
}

export type ToolCallLogger = (outcome: ToolCallOutcome) => void | Promise<void>;

const MAX_ERROR_LENGTH = 1000;

export function hashToolArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = "";
  }
  return createHash("sha256").update(text).digest("hex");
}

/** The database sink: one logs.tool_calls row per served call, attributed to
 * the request's verified actor and the agent it was served for. */
export function databaseToolCallLogger(
  database: RelayDatabase,
  agent: Agent,
  userId: string | null,
): ToolCallLogger {
  return ({ tool, argsHash, ms, error, read }) =>
    database.logToolCall({
      userId,
      agent,
      tool,
      argsHash,
      ms,
      error: error === null ? null : error.slice(0, MAX_ERROR_LENGTH),
      table: read?.table ?? null,
      columns: read?.select ?? null,
      filterKeys: read?.filterKeys ?? null,
      rowCount: read?.rowCount ?? null,
      flagged: read?.flagged ?? false,
    });
}

/** A tool handler catches its own failures and returns `{ isError: true, … }`,
 * so the refusal text lives in the result, not a thrown error. */
function refusalText(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError !== true) return null;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return "tool failed";
}

async function record(log: ToolCallLogger, outcome: ToolCallOutcome): Promise<void> {
  try {
    await log(outcome);
  } catch (error) {
    // A logging sink must never fail the tool it records; say so and move on.
    console.error("[relay-tools] tool-call log failed", error);
  }
}

/**
 * Wrap every tool registered on `server` so each call is recorded exactly
 * once with its timing, an argument hash, and any refusal text. It must run
 * before the first registerTool — including the browser and search servers,
 * which register onto the same instance afterwards.
 *
 * A handler can attach request-scoped read audit detail by writing it into
 * `meta.current` before returning; the wrapper picks it up, records it, and
 * clears the holder so a later call on the same instance cannot reuse it.
 */
export function instrumentToolCalls(
  server: object,
  log: ToolCallLogger,
  meta?: { current?: ReadAudit | null },
): void {
  const registrar = server as { registerTool: (...args: any[]) => unknown };
  const original = registrar.registerTool.bind(server);
  registrar.registerTool = ((name: string, config: unknown, handler: (...args: any[]) => unknown) =>
    original(name, config, async (...args: any[]) => {
      const started = Date.now();
      try {
        const result = await handler(...args);
        const read = meta?.current ?? null;
        if (meta) meta.current = null;
        await record(log, { tool: name, argsHash: hashToolArgs(args[0]), ms: Date.now() - started, error: refusalText(result), read });
        return result;
      } catch (error) {
        const read = meta?.current ?? null;
        if (meta) meta.current = null;
        await record(log, { tool: name, argsHash: hashToolArgs(args[0]), ms: Date.now() - started, error: error instanceof Error ? error.message : "request refused", read });
        throw error;
      }
    })) as typeof registrar.registerTool;
}
