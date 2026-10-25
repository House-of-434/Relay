/** Single source of truth for meeting-URL/platform identity.
 *
 * Pure, sync, zero-deps. Safe to import from the harness monitor, the capture
 * worker, and the tool layer. The monitor, the worker's urls facade and the
 * manual-intent URL key all delegate here; no second host list may exist.
 *
 * Invariants:
 * - Vanity/corp portals are NEVER provider hosts: auto-discovery skips them.
 * - Passcode never logged; travels only in JoinDescriptor.
 * - meetingUrlKey strips query/fragment so Zoom ?pwd= variants dedupe to one room.
 */

export type ScribePlatform = "google_meet" | "zoom" | "teams";

export interface CalendarEventLike {
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string; passcode?: string }> };
  hangoutLink?: string;
  description?: string;
  location?: string;
}

function lowerHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

export function isMeetHost(host: string): boolean {
  return host === "meet.google.com";
}

export function isZoomHost(host: string): boolean {
  return (
    host === "zoom.us" ||
    host.endsWith(".zoom.us") ||
    host === "zoom.com" ||
    host.endsWith(".zoom.com")
  );
}

export function isTeamsHost(host: string): boolean {
  return (
    host === "teams.microsoft.com" ||
    host === "teams.live.com" ||
    host === "teams.cloud.microsoft" ||
    host === "teams.microsoft.us" ||
    host.endsWith(".teams.microsoft.com")
  );
}

/** Platform for a meeting URL, or null when the host is not a provider. */
export function platformForUrl(url: string): ScribePlatform | null {
  const host = lowerHost(url);
  if (!host) return null;
  if (isMeetHost(host)) return "google_meet";
  if (isZoomHost(host)) return "zoom";
  if (isTeamsHost(host)) return "teams";
  return null;
}

/** Allowed join hosts per platform — a descriptor URL is validated before use. */
export function hostAllowed(platform: string, url: string): boolean {
  // The host sets are disjoint, so "does this URL belong to this platform" is
  // exactly platformForUrl; one predicate instead of a second copy of the table.
  return platformForUrl(url) === platform;
}

/** Meet meeting code from a URL (native_id). */
export function meetCode(url: string): string | null {
  const host = lowerHost(url);
  // isMeetHost, not endsWith: "evil-meet.google.com" is not a Meet host.
  if (!host || !isMeetHost(host)) return null;
  try {
    const code = new URL(url).pathname.replace(/^\//, "").split("/")[0];
    return code && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

/** Native meeting id per platform, used as native_id and in the live-meeting
 * unique index. Zoom: the /j/<id>, /wc/<id> or /s/<id> segment. Teams: /meet/<id>. */
export function nativeIdFor(platform: string, url: string): string | null {
  // A claimed platform that does not own the URL would otherwise mint an id for
  // a host this module rejects elsewhere (e.g. a Meet link labelled zoom).
  if (platform === "google_meet") return meetCode(url);
  if (platformForUrl(url) !== platform) return null;
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    const host = u.hostname.toLowerCase();
    const markers = isZoomHost(host) ? ["j", "wc", "s"] : ["meet", "meeting"];
    const i = seg.findIndex((s) => markers.includes(s));
    return i >= 0 && seg[i + 1] ? seg[i + 1]! : null;
  } catch {
    return null;
  }
}

/** Provider URL pattern for the description/location fallback scan. Broadened
 * beyond the original (which missed bare zoom.us, zoom.com, and Teams clouds):
 * meet.google.com, bare or subdomain zoom.us/zoom.com, Teams commercial/live/cloud. */
const URL_IN_TEXT =
  /https?:\/\/(?:meet\.google\.com|(?:[\w-]+\.)?zoom\.(?:us|com)|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/[^\s"'<>]+/i;

/** Join URL from a calendar event: video entry point, then hangoutLink, then
 * the first provider URL found in description/location. */
export function meetingUrlFor(event: CalendarEventLike): string | null {
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && typeof e.uri === "string" && e.uri.startsWith("http"),
  );
  if (video?.uri) return video.uri;
  if (typeof event.hangoutLink === "string" && event.hangoutLink.startsWith("http")) return event.hangoutLink;
  for (const text of [event.description, event.location]) {
    if (typeof text !== "string") continue;
    // Fresh exec per call: URL_IN_TEXT is module-global without /g, so no
    // lastIndex state leaks between events.
    const match = URL_IN_TEXT.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** Query/fragment keys that may carry a dial-in passcode. Single definition
 * shared by passcodeFor (read) and redactMeetingUrlSecrets (log scrubbing),
 * so a newly understood key cannot leak through the redactor. */
export const SECRET_URL_KEYS = ["pwd", "password", "passcode"] as const;

/** Scrub dial-in secrets from text before logging. Covers every key in
 * SECRET_URL_KEYS in both the query string (?pwd=) and the fragment
 * (#pwd=); the key name's own casing is preserved, the rest of the input
 * is byte-identical, and input without secrets (including a malformed URL)
 * is returned unchanged. Never throws. */
export function redactMeetingUrlSecrets(url: string): string {
  const keys = SECRET_URL_KEYS.join("|");
  return url.replace(new RegExp(`([?&#](?:${keys})=)[^&\\s#;]*`, "gi"), "$1REDACTED");
}

/** Dial-in passcode, if any. Entry-point passcode first, then URL params
 * pwd > password > passcode (query, then fragment). Never throws. */
export function passcodeFor(event: CalendarEventLike, url: string): string | undefined {
  const fromEntry = event.conferenceData?.entryPoints?.find(
    (e) => typeof e.passcode === "string" && e.passcode.length > 0,
  )?.passcode;
  if (typeof fromEntry === "string" && fromEntry.length > 0) return fromEntry;
  try {
    const parsed = new URL(url);
    for (const key of SECRET_URL_KEYS) {
      const value = parsed.searchParams.get(key);
      if (value && value.length > 0) return value;
    }
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const fragmentQuery = hash.startsWith("?") ? hash.slice(1) : hash.includes("=") ? hash : "";
    if (fragmentQuery) {
      const fragmentParams = new URLSearchParams(fragmentQuery);
      for (const key of SECRET_URL_KEYS) {
        const value = fragmentParams.get(key);
        if (value && value.length > 0) return value;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Normalized room identity for cross-instance dedup: platform plus lowercase
 * host (trailing dot stripped) plus path, query and fragment dropped. Purely
 * syntactic — destination safety is the navigation guard's job, never inferred
 * from this key. Null when the URL is unusable. */
export function meetingUrlKey(platform: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes(" ") || host.includes("..")) return null;
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path) path = "/";
  return `${platform}|${host}${path}`;
}

/** Active-session matching key. Purely syntactic — destination safety (SSRF)
 * is enforced separately at the route, never inferred from this key. Null
 * unless the URL's own platform matches the claimed one. */
export function normalizeMeetingUrlKey(platform: ScribePlatform, url: string): string | null {
  if (platformForUrl(url) !== platform) return null;
  return meetingUrlKey(platform, url);
}
