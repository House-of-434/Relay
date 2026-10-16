/** Navigation guard: IP classification, per-request verdicts, and the
 * install wiring. Resolver is injected — no live DNS in tests. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createNavigationGuard,
  isPublicIpAddress,
} from "./navigation-guard.js";

test("isPublicIpAddress rejects v4 special ranges", () => {
  for (const ip of [
    "0.0.0.5", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "999.1.1.1", "1.2.3",
  ]) {
    assert.equal(isPublicIpAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.1.2", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1"]) {
    assert.equal(isPublicIpAddress(ip), true, ip);
  }
});

test("isPublicIpAddress rejects v6 special ranges and mapped privates", () => {
  for (const ip of [
    "::", "::1", "fe80::1", "fe9f::1", "fc00::1", "fd00::1", "ff02::1",
    "2001:db8::1", "2001::1", "2002:c000:200::", "100::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "fe80::1%eth0", "not-an-ip",
  ]) {
    assert.equal(isPublicIpAddress(ip), false, ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicIpAddress(ip), true, ip);
  }
});

const MEET = "https://meet.google.com/abc-defg-hij";
const resolvePublic = async (host: string): Promise<string[]> =>
  host === "meet.google.com" ? ["142.250.1.2", "2607:f8b0:4004:837::200e"] : ["93.184.216.34"];

test("createNavigationGuard refuses bad meeting destinations before any browser", async () => {
  await assert.rejects(createNavigationGuard({ meetingUrl: "http://meet.google.com/x", resolve: resolvePublic }), /https/);
  await assert.rejects(
    createNavigationGuard({ meetingUrl: "https://meet.google.com@127.0.0.1/", resolve: resolvePublic }),
    /credentials/,
  );
  await assert.rejects(createNavigationGuard({ meetingUrl: "https://meet.google.com/x", resolve: async () => [] }), /resolve/);
  await assert.rejects(
    createNavigationGuard({ meetingUrl: "https://meet.google.com/x", resolve: async () => ["10.0.0.5"] }),
    /non-public/,
  );
});

test("decide allows the meeting host and public supporting hosts", async () => {
  const guard = await createNavigationGuard({ meetingUrl: MEET, resolve: resolvePublic });
  assert.deepEqual((await guard.decide(MEET)).allow, true);
  assert.deepEqual((await guard.decide("https://accounts.google.com/o/oauth2/auth")).allow, true);
  assert.deepEqual((await guard.decide("data:text/plain,hi")).allow, true);
  assert.deepEqual(guard.pinnedIps, ["142.250.1.2", "2607:f8b0:4004:837::200e"]);
});

test("decide aborts literals, private answers, credentials, ports, schemes", async () => {
  const guard = await createNavigationGuard({ meetingUrl: MEET, resolve: resolvePublic });
  assert.deepEqual((await guard.decide("http://127.0.0.1:8798/x")).allow, false);
  assert.deepEqual((await guard.decide("https://142.250.1.2/x")).allow, true); // pinned meeting address
  assert.deepEqual((await guard.decide("https://meet.google.com:8443/x")).allow, false);
  assert.deepEqual((await guard.decide("https://user:pass@meet.google.com/x")).allow, false);
  assert.deepEqual((await guard.decide("ftp://meet.google.com/x")).allow, false);
  assert.deepEqual((await guard.decide("file:///etc/passwd")).allow, false);
  const privateResolver = async (host: string): Promise<string[]> =>
    host === "meet.google.com" ? ["142.250.1.2"] : ["169.254.169.254"];
  const guarded = await createNavigationGuard({ meetingUrl: MEET, resolve: privateResolver });
  assert.deepEqual((await guarded.decide("https://evil.example/metadata")).allow, false);
  assert.deepEqual((await guarded.decide("https://[::ffff:7f00:1]/x")).allow, false);
});

test("resolver results are cached per guard", async () => {
  let calls = 0;
  const guard = await createNavigationGuard({
    meetingUrl: MEET,
    resolve: async (host) => {
      calls += 1;
      return host === "meet.google.com" ? ["142.250.1.2"] : ["93.184.216.34"];
    },
  });
  await guard.decide("https://cdn.example/a.js");
  await guard.decide("https://cdn.example/b.js");
  assert.equal(calls, 2); // once for the meeting host, once for the CDN host
});

test("install aborts blocked requests and continues allowed ones", async () => {
  const logs: string[] = [];
  const guard = await createNavigationGuard({ meetingUrl: MEET, resolve: resolvePublic, log: (m) => logs.push(m) });
  let handler: ((route: unknown) => void) | null = null;
  const context = {
    route: async (_pattern: string, fn: (route: unknown) => void) => { handler = fn; },
  };
  await guard.install(context as never);
  assert.ok(handler, "route handler installed");

  const run = async (url: string) => {
    const actions: string[] = [];
    const route = {
      request: () => ({ url: () => url }),
      continue: async () => { actions.push("continue"); },
      abort: async () => { actions.push("abort"); },
    };
    await (handler as (route: unknown) => Promise<void>)(route);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    return actions;
  };

  assert.deepEqual(await run(MEET), ["continue"]);
  // A public Zoom room continues (supporting/redirect traffic shares the rule).
  assert.deepEqual(await run("https://houseof434.zoom.us/j/123?pwd=topsecret"), ["continue"]);
  // Blocked URLs log the host only: ?pwd= must never reach logs.
  assert.deepEqual(await run("http://127.0.0.1:8798/x?pwd=topsecret"), ["abort"]);
  assert.ok(logs.some((line) => line.includes("127.0.0.1")));
  assert.ok(!logs.some((line) => line.includes("topsecret")));
});

test("install fails closed when the verdict throws", async () => {  const guard = await createNavigationGuard({ meetingUrl: MEET, resolve: resolvePublic });
  let handler: ((route: unknown) => void) | null = null;
  await guard.install({ route: async (_p: string, fn: (r: unknown) => void) => { handler = fn; } } as never);
  assert.ok(handler, "route handler installed");
  const actions: string[] = [];
  await (handler as (r: unknown) => Promise<void>)({
    request: () => ({ url: () => { throw new Error("no url"); } }),
    continue: async () => { actions.push("continue"); },
    abort: async () => { actions.push("abort"); },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(actions, ["abort"]);
});

test("each redirect hop is validated independently, after an allowed first hop", async () => {
  // A same-host path stays allowed while its answers are public; a hop to a
  // host answering private aborts even mid-chain. Per-session DNS caching
  // means the meeting host cannot rebind between hops; new hosts resolve
  // fresh on first sight.
  const guard = await createNavigationGuard({
    meetingUrl: MEET,
    resolve: async (host) => host === "meet.google.com" ? ["142.250.1.2"] : ["169.254.169.254"],
  });
  assert.deepEqual((await guard.decide("https://meet.google.com/abc-defg-hij")).allow, true);
  assert.deepEqual((await guard.decide("https://meet.google.com/redirect-out")).allow, true);
  assert.deepEqual((await guard.decide("https://cdn.evil.example/pixel")).allow, false);
});
