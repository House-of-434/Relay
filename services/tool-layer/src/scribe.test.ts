import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeScribe, SCRIBE_PERMISSIONS } from "./domain/permissions.js";
import { nativeIdForUrl, RelayScribeJoinClient, SCRIBE_INTERNAL_PATHS, ScribeRequestError } from "./infra/scribe.js";
import { summarizeCapture } from "./mcp/scribe-status.js";
import { RelayDatabase } from "./infra/database.js";

const SECRET = "relay-tool-actor-secret-test-value-over-32-bytes";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR = '{"userId":"1457cb2a-7543-4b48-8854-a63cd160241f","botId":"bot","threadId":"thread"}';
const MEET = "https://meet.google.com/abc-defg-hij";

test("only Mercury may request a capture join", () => {
  assert.deepEqual([...SCRIBE_PERMISSIONS.mercury], ["join"]);
  assert.deepEqual(SCRIBE_PERMISSIONS.scout, []);
  assert.deepEqual(SCRIBE_PERMISSIONS.curator, []);
  assert.doesNotThrow(() => authorizeScribe("mercury", "join"));
  assert.throws(() => authorizeScribe("scout", "join"), /join access denied for scout/);
  assert.throws(() => authorizeScribe("curator", "join"), /join access denied for curator/);
});

test("the join client posts exactly one harness path", () => {
  assert.deepEqual(Object.values(SCRIBE_INTERNAL_PATHS), ["/api/internal/scribe/join"]);
});

test("the client sends capability, actor, and idempotency key", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayScribeJoinClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return Response.json({ status: "accepted", instance_id: "inst-1" });
    }) as typeof fetch,
  });

  const result = await client.joinMeeting(ACTOR, {
    requestKey: "66666666-6666-4666-8666-666666666666",
    meetingUrl: MEET,
    title: "Investor sync",
  });
  assert.deepEqual(result, { status: "accepted", instance_id: "inst-1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://127.0.0.1:8798/api/internal/scribe/join");
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${CAPABILITY}`);
  assert.equal(headers["x-relay-actor-user"], ACTOR);
  assert.deepEqual(JSON.parse(seen[0]!.init.body as string), {
    request_key: "66666666-6666-4666-8666-666666666666",
    meeting_url: MEET,
    title: "Investor sync",
  });
});

test("the client maps refusal, misconfiguration, and transport failures", async () => {
  const refusing = new RelayScribeJoinClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => Response.json({ error: "meeting host is not a supported provider" }, { status: 400 })) as typeof fetch,
  });
  await assert.rejects(
    refusing.joinMeeting(ACTOR, { requestKey: "k", meetingUrl: "https://evil.example/x" }),
    (error: unknown) => error instanceof ScribeRequestError && error.status === 400 &&
      /not a supported provider/.test(error.message),
  );

  const unconfigured = new RelayScribeJoinClient({ bffInternalUrl: "http://127.0.0.1:8798", capability: undefined });
  await assert.rejects(
    unconfigured.joinMeeting(ACTOR, { requestKey: "k", meetingUrl: MEET }),
    /not configured/,
  );

  const unreachable = new RelayScribeJoinClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => { throw new Error("down"); }) as typeof fetch,
  });
  await assert.rejects(unreachable.joinMeeting(ACTOR, { requestKey: "k", meetingUrl: MEET }), /unreachable/);

  const weird = new RelayScribeJoinClient({
    bffInternalUrl: "http://127.0.0.1:8798",
    capability: CAPABILITY,
    fetcher: (async () => Response.json({ unexpected: true })) as typeof fetch,
  });
  await assert.rejects(weird.joinMeeting(ACTOR, { requestKey: "k", meetingUrl: MEET }), /unexpectedly/);
});

test("native ids mirror the capture worker", () => {
  assert.deepEqual(nativeIdForUrl("https://meet.google.com/abc-defg-hij?authuser=0"), { platform: "google_meet", nativeId: "abc-defg-hij" });
  assert.deepEqual(nativeIdForUrl("https://us02web.zoom.us/j/9876543210?pwd=x"), { platform: "zoom", nativeId: "9876543210" });
  assert.deepEqual(nativeIdForUrl("https://zoom.us/wc/555"), { platform: "zoom", nativeId: "555" });
  assert.deepEqual(nativeIdForUrl("https://teams.live.com/meet/9336569415432?p=abc"), { platform: "teams", nativeId: "9336569415432" });
  assert.equal(nativeIdForUrl("https://evil.example/x"), null);
  assert.equal(nativeIdForUrl("https://meet.google.com@127.0.0.1/"), null);
  assert.equal(nativeIdForUrl("not a url"), null);
  assert.equal(nativeIdForUrl("https://zoom.us/j/"), null);
});

test("Mercury alone lists scribe_join_meeting and scribe_capture_status", async () => {
  const { createAgentMcpServer } = await import("./mcp/agent-server.js");
  const scribe = { client: {} as never, actorAssertion: ACTOR };
  type Listing = { _registeredTools: Record<string, unknown> };
  const toolsOf = (agent: "scout" | "mercury" | "curator") =>
    Object.keys((createAgentMcpServer(agent, { userId: "u" }, {} as never, undefined, undefined, undefined, undefined, undefined, scribe) as unknown as Listing)._registeredTools);

  assert.ok(toolsOf("mercury").includes("scribe_join_meeting"));
  assert.ok(toolsOf("mercury").includes("scribe_capture_status"));
  for (const agent of ["scout", "curator"] as const) {
    assert.ok(!toolsOf(agent).includes("scribe_join_meeting"));
    assert.ok(!toolsOf(agent).includes("scribe_capture_status"));
  }
});

test("the join tool never claims the bot joined", async () => {
  const { createAgentMcpServer } = await import("./mcp/agent-server.js");
  const scribe = { client: {} as never, actorAssertion: ACTOR };
  const listing = (createAgentMcpServer("mercury", { userId: "u" }, {} as never, undefined, undefined, undefined, undefined, undefined, scribe) as unknown as {
    _registeredTools: Record<string, { description?: string }>;
  })._registeredTools;
  const description = String(listing.scribe_join_meeting?.description ?? "");
  assert.match(description, /queued/i);
  assert.match(description, /scribe_capture_status/);
  assert.doesNotMatch(description, /should be joining|will be captured|has joined/i);
});

test("summarizeCapture is honest in every state", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "m1", instance_id: "i1", native_id: "abc", title: "Investor sync",
    status: "active", segment_count: 3, actual_start: "2026-10-15T17:01:00Z",
    organizer_email: null, error: null, ...over,
  });

  const missing = summarizeCapture(null, { instance_id: "i9" });
  assert.equal(missing.phase, "requested");
  assert.equal(missing.joined, false);
  assert.equal(missing.transcript.ready, false);

  const live = summarizeCapture(row({}), { instance_id: "i1" });
  assert.equal(live.phase, "in_meeting");
  assert.equal(live.joined, true);
  assert.equal(live.transcript.ready, true);
  assert.equal(live.transcript.meeting_id, "m1");

  const liveEmpty = summarizeCapture(row({ segment_count: 0 }), { instance_id: "i1" });
  assert.equal(liveEmpty.phase, "in_meeting");
  assert.equal(liveEmpty.transcript.ready, false);

  const done = summarizeCapture(row({ status: "completed", segment_count: 12 }), { instance_id: "i1" });
  assert.equal(done.phase, "completed");
  assert.match(done.note, /get_meeting_transcript/);

  const doneEmpty = summarizeCapture(row({ status: "partial", segment_count: 0 }), { instance_id: "i1" });
  assert.equal(doneEmpty.phase, "completed");
  assert.equal(doneEmpty.transcript.ready, false);

  const failed = summarizeCapture(row({ status: "failed", segment_count: 0, error: "at capacity" }), { instance_id: "i1" });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.joined, false);
  assert.match(failed.note, /at capacity/);

  const failedPartial = summarizeCapture(row({ status: "failed", segment_count: 4 }), { instance_id: "i1" });
  assert.equal(failedPartial.phase, "failed");
  assert.equal(failedPartial.joined, true);
  assert.equal(failedPartial.transcript.ready, true);
});

test("findMeetingsByInstanceIds queries the transcript rows", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  const row = { id: "m1", instance_id: "i1", native_id: "abc", title: "T", status: "active", segment_count: 3, actual_start: "2026-10-15T17:01:00Z", organizer_email: null, error: null };
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return Response.json([row]);
  }) as typeof fetch;
  try {
    const db = new RelayDatabase({
      RELAY_DB_URL: "https://relay-test.supabase.co",
      RELAY_DB_PROJECT_REF: "relay-test",
      RELAY_DB_SERVICE_ROLE_KEY: "test-service-role-key",
      RELAY_TOOL_ACTOR_SECRET: SECRET,
    });
    assert.deepEqual(await db.findMeetingsByInstanceIds([]), []);
    assert.equal(seen.length, 0);
    const rows = await db.findMeetingsByInstanceIds(["i1", "", "i1"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.instance_id, "i1");
    assert.ok(seen.some((u) => decodeURIComponent(u).includes("instance_id=in.(i1)")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
