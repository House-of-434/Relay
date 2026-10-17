import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeScribe, SCRIBE_PERMISSIONS } from "./domain/permissions.js";
import { RelayScribeJoinClient, SCRIBE_INTERNAL_PATHS, ScribeRequestError } from "./infra/scribe.js";

const CAPABILITY = "internal-bff-capability-fixture-value-0000000000000000";
const ACTOR = '{"userId":"1457cb2a-7543-4b48-8854-a63cd160241f","botId":"bot","threadId":"thread"}';
const MEET = "https://meet.google.com/abc-defg-hij";

test("only Mercury may join or stop a capture", () => {
  assert.deepEqual([...SCRIBE_PERMISSIONS.mercury], ["join", "stop"]);
  assert.deepEqual(SCRIBE_PERMISSIONS.scout, []);
  assert.deepEqual(SCRIBE_PERMISSIONS.curator, []);
  assert.doesNotThrow(() => authorizeScribe("mercury", "join"));
  assert.doesNotThrow(() => authorizeScribe("mercury", "stop"));
  assert.throws(() => authorizeScribe("scout", "join"), /join access denied for scout/);
  assert.throws(() => authorizeScribe("curator", "stop"), /stop access denied for curator/);
});

test("the scribe client posts to the join and stop BFF paths", () => {
  assert.deepEqual(Object.values(SCRIBE_INTERNAL_PATHS), [
    "/api/internal/scribe/join",
    "/api/internal/scribe/stop",
  ]);
});

test("stopMeeting posts the reference to the stop path with capability and actor", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new RelayScribeJoinClient({
    bffInternalUrl: "http://127.0.0.1:8798/",
    capability: CAPABILITY,
    fetcher: (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "stopped", instance_id: "inst-1" }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const result = await client.stopMeeting(ACTOR, { meetingUrl: MEET });
  assert.deepEqual(result, { status: "stopped", instance_id: "inst-1" });
  assert.equal(seen[0]!.url, "http://127.0.0.1:8798/api/internal/scribe/stop");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${CAPABILITY}`);
  assert.equal((seen[0]!.init.headers as Record<string, string>)["x-relay-actor-user"], ACTOR);
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { meeting_url: MEET });
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
    Object.keys((createAgentMcpServer(agent, { userId: "u" }, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, scribe) as unknown as Listing)._registeredTools);

  assert.ok(toolsOf("mercury").includes("scribe_join_meeting"));
  for (const agent of ["scout", "curator"] as const) {
    assert.ok(!toolsOf(agent).includes("scribe_join_meeting"));
  }
});

test("the join tool never claims the bot joined", async () => {
  const { createAgentMcpServer } = await import("./mcp/agent-server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const scribe = {
    client: { joinMeeting: async () => ({ status: "accepted", instance_id: "inst-1" }) } as never,
    actorAssertion: ACTOR,
  };
  const server = createAgentMcpServer("mercury", { userId: "u" }, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, scribe);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scribe-join-note-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "scribe_join_meeting", arguments: { meeting_url: MEET } });
    const text = JSON.stringify(result);
    assert.match(text, /confirm/i);
    assert.match(text, /rather than claiming/i);
    assert.doesNotMatch(text, /already in the meeting|has joined the meeting|successfully joined/i);
  } finally {
    await client.close();
    await server.close();
  }
});
