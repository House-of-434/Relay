/** Capture-browser navigation guard: connection-level SSRF enforcement.
 *
 * The harness validates URL shape before accepting a join, but shape checks
 * cannot pin DNS or constrain redirects — and Playwright's page.goto follows
 * redirects natively. This guard runs INSIDE the capture worker, at the only
 * point that actually opens connections: the browser's request pipeline.
 *
 * Three mechanisms, each covering the others' gaps:
 * 1. Host-resolver pinning: the meeting host is resolved once, every answer
 *    must be a public address, and Chromium is launched with
 *    --host-resolver-rules mapping the host to the validated addresses. DNS
 *    cannot rebind between validation and connection.
 * 2. Pre-flight interception: a context-wide route handler validates EVERY
 *    request before it leaves the browser — initial navigation, every
 *    redirect hop (Playwright re-fires the handler per hop with the
 *    redirectedFrom chain), subresources, iframes, popups. Aborted requests
 *    never contact their destination, so post-navigation rejection races do
 *    not apply. Destinations resolving to non-public addresses (IPv4 and
 *    IPv6, including mapped/embedded forms), IP literals outside the pinned
 *    set, and credentialed URLs are all refused.
 * 3. Uniform policy: navigation and supporting traffic (auth, CDN) share one
 *    rule — every hop must resolve public. There is no weaker lane for an
 *    attacker-controlled redirect to hide in.
 *
 * Out of scope by design: UDP media (STUN/TURN) never traverses the request
 * pipeline — same residual as any browser. Container-level egress policy is
 * a separate network-architecture change (the worker legitimately shares the
 * compose subnet with the tool layer).
 *
 * Logs carry hosts and reasons only — never full URLs, which may embed
 * meeting passcodes.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { BrowserContext, Route } from "playwright";

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expand an IPv6 literal to eight 16-bit groups, or null when malformed.
 * Handles "::" compression (at most once) and embedded dotted quads. */
function expandV6(ip: string): number[] | null {
  let head = ip;
  let zone = "";
  const zoneAt = head.indexOf("%");
  if (zoneAt >= 0) {
    zone = head.slice(zoneAt + 1);
    head = head.slice(0, zoneAt);
    if (!zone) return null;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parseGroup = (text: string): number[] | null => {
    if (text === "") return [];
    const out: number[] = [];
    for (const part of text.split(":")) {
      if (part.includes(".")) {
        const v4 = parseV4(part);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = parseGroup(halves[0]!);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseGroup(halves[0]!);
  const right = parseGroup(halves[1]!);
  if (!left || !right || left.length + right.length > 7) return null;
  const zeros = 8 - left.length - right.length;
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

function isPublicV4(octets: number[]): boolean {
  const [a, b, c, d] = octets as [number, number, number, number];
  void d;
  if (a === 0) return false; // this network
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT shared space
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1 documentation
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && b >= 18 && b <= 19) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2 documentation
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3 documentation
  if (a >= 224 && a <= 239) return false; // multicast
  if (a >= 240) return false; // reserved + broadcast
  return true;
}

function isPublicV6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicV4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
    if (g7 === 0) return false; // unspecified ::
    if (g7 === 1) return false; // loopback ::1
  }
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0000) return false; // Teredo tunneling
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 relay (unpredictable egress)
  if (g0 === 0x0100 && g1 === 0x0000 && g2 === 0x0000 && g3 === 0x0000) return false; // discard 100::/64
  return true;
}

/** True only for globally routable unicast destinations, v4 and v6. */
export function isPublicIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const octets = parseV4(ip);
    return octets !== null && isPublicV4(octets);
  }
  if (version === 6) {
    const clean = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
    // A zone id scopes to a local interface: never a public destination.
    if (clean !== ip) return false;
    const groups = expandV6(ip);
    return groups !== null && isPublicV6(groups);
  }
  return false;
}

async function defaultResolve(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch((): string[] => []),
    dns.resolve6(host).catch((): string[] => []),
  ]);
  return [...new Set([...v4, ...v6])];
}

export interface NavigationGuardOptions {
  meetingUrl: string;
  resolve?: (host: string) => Promise<string[]>;
  log?: (message: string) => void;
}

export interface NavigationGuard {
  meetingHost: string;
  pinnedIps: string[];
  /** Chromium --host-resolver-rules flag pinning the meeting host, or null
   * when pinning is unavailable (interception still enforces). */
  resolverRulesFlag(): string | null;
  install(context: BrowserContext): Promise<void>;
  /** The per-request verdict, exposed for tests. Aborts never contact. */
  decide(url: string): Promise<{ allow: boolean; reason: string }>;
}

/** Build the guard: parse + resolve + validate the meeting host NOW, so a
 * non-public or unresolvable destination fails the join before any browser
 * exists. Throws on violation — the session surfaces it as a failed join. */
export async function createNavigationGuard(options: NavigationGuardOptions): Promise<NavigationGuard> {
  const log = options.log ?? ((): void => {});
  const resolve = options.resolve ?? defaultResolve;
  let meeting: URL;
  try {
    meeting = new URL(options.meetingUrl);
  } catch {
    throw new Error("guard: meeting URL does not parse");
  }
  if (meeting.protocol !== "https:") throw new Error("guard: meeting URL must be https");
  if (meeting.username || meeting.password) throw new Error("guard: meeting URL must not carry credentials");
  const meetingHost = meeting.hostname.toLowerCase();
  if (!meetingHost) throw new Error("guard: meeting URL has no host");
  const pinnedIps = await resolve(meetingHost);
  if (pinnedIps.length === 0) throw new Error(`guard: meeting host does not resolve: ${meetingHost}`);
  for (const ip of pinnedIps) {
    if (!isPublicIpAddress(ip)) throw new Error(`guard: meeting host resolves non-public: ${meetingHost}`);
  }

  const cache = new Map<string, string[]>([[meetingHost, pinnedIps]]);

  async function addressesOf(host: string): Promise<string[]> {
    const hit = cache.get(host);
    if (hit) return hit;
    const ips = await resolve(host);
    cache.set(host, ips);
    return ips;
  }

  async function decide(url: string): Promise<{ allow: boolean; reason: string }> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { allow: false, reason: "unparseable URL" };
    }
    // Page internals never touch the network.
    if (target.protocol === "data:" || target.protocol === "blob:" || target.protocol === "about:") {
      return { allow: true, reason: "page-internal" };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:" &&
        target.protocol !== "wss:" && target.protocol !== "ws:") {
      return { allow: false, reason: `unexpected scheme ${target.protocol}` };
    }
    if (target.username || target.password) return { allow: false, reason: "URL carries credentials" };
    if (target.port !== "" && target.port !== "80" && target.port !== "443") {
      return { allow: false, reason: `unexpected port ${target.port}` };
    }
    const host = target.hostname.toLowerCase();
    if (isIP(host)) {
      // No DNS involved: allow only the pinned meeting addresses.
      return pinnedIps.includes(host)
        ? { allow: true, reason: "pinned meeting address" }
        : { allow: false, reason: `IP literal outside pinned set: ${host}` };
    }
    const ips = await addressesOf(host);
    if (ips.length === 0) return { allow: false, reason: `host does not resolve: ${host}` };
    for (const ip of ips) {
      if (!isPublicIpAddress(ip)) return { allow: false, reason: `host resolves non-public: ${host}` };
    }
    return { allow: true, reason: host === meetingHost ? "meeting host" : "public supporting host" };
  }

  return {
    meetingHost,
    pinnedIps: [...pinnedIps],
    resolverRulesFlag() {
      const firstV4 = pinnedIps.find((ip) => isIP(ip) === 4) ?? pinnedIps[0];
      if (!firstV4) return null;
      return `--host-resolver-rules=MAP ${meetingHost} ${firstV4}`;
    },
    async install(context: BrowserContext): Promise<void> {
      // Context-wide: covers the initial navigation, every redirect hop
      // (each fires the handler with its redirectedFrom chain), subresources,
      // iframes, and popups. The handler runs before the request leaves the
      // browser, so abort() means no contact — there is no post-navigation
      // rejection race.
      await context.route("**", (route: Route) => {
        void (async () => {
          let verdict: { allow: boolean; reason: string };
          try {
            verdict = await decide(route.request().url());
          } catch {
            verdict = { allow: false, reason: "verdict error" };
          }
          try {
            if (verdict.allow) await route.continue();
            else {
              let host = "?";
              try {
                host = new URL(route.request().url()).hostname.toLowerCase();
              } catch {
                /* keep placeholder */
              }
              log(`guard: blocked host ${host} (${verdict.reason})`);
              await route.abort();
            }
          } catch {
            /* page gone mid-verdict: nothing to enforce on */
          }
        })();
      });
    },
    decide,
  };
}
