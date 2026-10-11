import assert from "node:assert/strict";
import test from "node:test";

import { IngestClient, IngestClientError, IngestConflictError } from "./ingest-client.js";
import type { MeetingRow } from "./types.js";

const CAP = "ingest-capability-that-is-at-least-32-bytes-long";
const row: MeetingRow = { platform: "google_meet", instance_id: "inst-1", status: "active" };

test("posts meeting and segments with the ingest bearer", async () => {
  let seen: { url: string; auth?: string; body?: unknown } = { url: "" };
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ meeting_id: "m-1", upserted: 2 }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new IngestClient({ url: "http://tool/internal/transcripts", capability: CAP, fetcher });
  const result = await client.post(row, [
    { segment_key: "turn:1", speaker: null, start_seconds: 0, end_seconds: 1, text: "hi" },
    { segment_key: "turn:2", speaker: null, start_seconds: 1, end_seconds: 2, text: "there" },
  ]);
  assert.deepEqual(result, { meeting_id: "m-1", upserted: 2 });
  assert.equal(seen.auth, `Bearer ${CAP}`);
  assert.deepEqual((seen.body as any).segments.length, 2);
});

test("a 409 becomes an IngestConflictError (live meeting)", async () => {
  const fetcher = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
  const client = new IngestClient({ url: "http://tool/x", capability: CAP, fetcher });
  await assert.rejects(() => client.post(row, []), (e: unknown) => e instanceof IngestConflictError);
});

test("a missing capability fails closed", async () => {
  const client = new IngestClient({ url: "http://tool/x", capability: undefined });
  await assert.rejects(() => client.post(row, []), (e: unknown) => e instanceof IngestClientError && e.status === 503);
});

test("an unreachable route is a 502", async () => {
  const fetcher = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const client = new IngestClient({ url: "http://tool/x", capability: CAP, fetcher });
  await assert.rejects(() => client.post(row, []), (e: unknown) => e instanceof IngestClientError && e.status === 502);
});
