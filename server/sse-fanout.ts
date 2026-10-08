// Per-client delivery decision for the SSE broadcast fan-out in index.ts.
// Pulled into its own file — not just its own function — because index.ts
// starts the real HTTP server as an import-time side effect (see the bottom
// of index.ts: `server.listen(...)` runs unconditionally on import), so it
// can never be imported from a plain unit test. This one function has no
// dependency on that module and can be driven directly with a fake response.

/** Shape broadcast() needs from an SSE client: a writable response. */
export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
  };
}

/** Past this many buffered bytes, the client isn't draining on any useful
 * timeframe: cut it loose rather than let Node's per-connection write buffer
 * grow without bound. Its own EventSource reconnects and replays via
 * Last-Event-ID (server/index.ts's existing replayBuffer/cursorSeq). */
// ponytail: fixed byte bound, not adaptive. Retune from real writableLength
// telemetry (see the audit's validation step) if it trips too eager or late.
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "disconnected";

/** One client's fate for one frame.
 *
 * Every event here is durable (messages, bot/group state, config, ...) and
 * is written regardless of the socket's drain state — nothing is silently
 * dropped. Past the byte bound the client is cut loose outright so its next
 * reconnect replays what it missed instead of silently losing it. */
export function deliverSseFrame(client: SseFanoutClient, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
    return "disconnected";
  }
  try {
    client.res.write(frame);
    return "sent";
  } catch {
    return "disconnected";
  }
}
