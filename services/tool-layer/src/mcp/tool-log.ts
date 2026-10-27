import { createHash } from "node:crypto";

import type { Agent } from "../domain/permissions.js";
import type { RelayDatabase } from "../infra/database.js";

export interface ToolCallOutcome {
  tool: string;
  /** sha256 of the call's arguments — never the arguments themselves. */
  argsHash: string;
  ms: number;
  error: string | null;
  /** relay_write detail: which entity row the call targeted or changed. Values
   * are never logged, only the table, operation, and row identity. */
  tableName?: string | null;
  operation?: "insert" | "update" | null;
  rowId?: string | null;
}

export type ToolCallLogger = (outcome: ToolCallOutcome) => void | Promise<void>;

const MAX_ERROR_LENGTH = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return ({ tool, argsHash, ms, error, tableName, operation, rowId }) =>
    database.logToolCall({
      userId,
      agent,
      tool,
      argsHash,
      ms,
      error: error === null ? null : error.slice(0, MAX_ERROR_LENGTH),
      tableName: tableName ?? null,
      operation: operation ?? null,
      rowId: rowId ?? null,
    });
}

interface WriteDetail {
  tableName?: string | null;
  operation?: "insert" | "update" | null;
  rowId?: string | null;
}

function rowIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (!first || typeof first !== "object") return null;
  const text = (first as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The row-level audit detail for a relay_write call. The write handler returns
 * the saved row, so an insert's id comes from the result; an update's id is the
 * where clause it targeted. Failed or non-write calls carry no row id. */
function writeDetail(tool: string, args: unknown, result: unknown): WriteDetail {
  if (tool !== "relay_write" || !args || typeof args !== "object" || Array.isArray(args)) return {};
  const input = args as { table?: unknown; operation?: unknown; where?: unknown };
  const tableName = typeof input.table === "string" ? input.table : null;
  const operation = input.operation === "insert" || input.operation === "update" ? input.operation : null;
  let rowId: string | null = null;
  if (operation === "update" && input.where && typeof input.where === "object" && !Array.isArray(input.where)) {
    const id = (input.where as { id?: unknown }).id;
    if (typeof id === "string" && UUID.test(id)) rowId = id;
  } else if (operation === "insert") {
    rowId = rowIdFromResult(result);
  }
  return { tableName, operation, rowId };
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
 */
export function instrumentToolCalls(server: object, log: ToolCallLogger): void {
  const registrar = server as { registerTool: (...args: any[]) => unknown };
  const original = registrar.registerTool.bind(server);
  registrar.registerTool = ((name: string, config: unknown, handler: (...args: any[]) => unknown) =>
    original(name, config, async (...args: any[]) => {
      const started = Date.now();
      try {
        const result = await handler(...args);
        await record(log, {
          tool: name,
          argsHash: hashToolArgs(args[0]),
          ms: Date.now() - started,
          error: refusalText(result),
          ...writeDetail(name, args[0], result),
        });
        return result;
      } catch (error) {
        await record(log, {
          tool: name,
          argsHash: hashToolArgs(args[0]),
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : "request refused",
          ...writeDetail(name, args[0], null),
        });
        throw error;
      }
    })) as typeof registrar.registerTool;
}
