import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeScribe, SCRIBE_PERMISSIONS } from "./domain/permissions.js";
import { RelayScribeJoinClient, SCRIBE_INTERNAL_PATHS, ScribeRequestError } from "./infra/scribe.js";

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

test("the join client posts exactly one BFF path", () => {
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

test("Mercury alone lists scribe_join_meeting", async () => {
  const { createAgentMcpServer } = await import("./mcp/agent-server.js");
  const scribe = { client: {} as never, actorAssertion: ACTOR };
  type Listing = { _registeredTools: Record<string, unknown> };
  const toolsOf = (agent: "scout" | "mercury" | "curator") =>
    Object.keys((createAgentMcpServer(agent, { userId: "u" }, {} as never, undefined, undefined, undefined, undefined, undefined, scribe) as unknown as Listing)._registeredTools);

  assert.ok(toolsOf("mercury").includes("scribe_join_meeting"));
  for (const agent of ["scout", "curator"] as const) {
    assert.ok(!toolsOf(agent).includes("scribe_join_meeting"));
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
  assert.match(description, /transcripts\.meetings/);
  assert.doesNotMatch(description, /should be joining|will be captured|has joined|scribe_capture_status/i);
});
