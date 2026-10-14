/** Pure URL helpers for the capture worker (no Playwright, so they unit-test
 * without a browser). */

/** Meet meeting code from a URL (native_id). */
export function meetCode(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("meet.google.com")) return null;
    const code = u.pathname.replace(/^\//, "").split("/")[0];
    return code && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

/** Native meeting id per platform, used as native_id and in the live-meeting
 * unique index. Zoom: the /j/<id>, /wc/<id> or /s/<id> segment. Teams: /meet/<id>. */
export function nativeIdFor(platform: string, url: string): string | null {
  if (platform === "google_meet") return meetCode(url);
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    const markers = u.hostname.endsWith("zoom.us") ? ["j", "wc", "s"] : ["meet"];
    const i = seg.findIndex((s) => markers.includes(s));
    return i >= 0 && seg[i + 1] ? seg[i + 1]! : null;
  } catch {
    return null;
  }
}

/** Allowed join hosts per platform — a descriptor URL is validated before use. */
export function hostAllowed(platform: string, url: string): boolean {  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (platform === "google_meet") return host === "meet.google.com";
  if (platform === "teams") return host === "teams.microsoft.com" || host === "teams.live.com";
  if (platform === "zoom") return host === "zoom.us" || host.endsWith(".zoom.us");
  return false;
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
