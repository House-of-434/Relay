// The shipping boot path with a Google sign-in already in hand:
// /api/auth/session answers the way the server does after a Google login, and
// src/main.tsx decides what that means. Everything under main.tsx is the real
// app, so the sidebar identity in this page is the one a signed-in teammate
// gets.
//
// ?scenario=broken-photo answers with a photo URL that cannot load, which is
// the initials fallback the sidebar has to survive.
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "google-photo";

/** Stand-in for the provider's photo bytes, drawn locally. Which hosts are
 *  allowed is the server's decision (services/bff); this only has to be
 *  something the sidebar's <img> can actually load. */
function photo(label: string, background: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.fillRect(0, 0, 128, 128);
  context.fillStyle = "#ffffff";
  context.font = "600 56px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 64, 68);
  return canvas.toDataURL("image/png");
}

const session = {
  kind: "session",
  id: "sess_fixture_google",
  label: "Ada's MacBook Pro",
  scopes: ["client"],
  expiresAt: Date.now() + 3_600_000,
  email: "ada@houseof434.com",
  displayName: "Ada Lovelace",
  avatarUrl: scenario === "broken-photo"
    ? "https://lh3.googleusercontent.com/a/fixture-there-is-no-photo-here=s96-c"
    : photo("AL", "#1f6feb"),
};
Object.assign(window, { sessionFixture: { scenario, session } });

setAnalyticsEnabled(false);
setEmailGateDone("skipped");

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === "/api/auth/session") {
    return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};

await import("../../src/main");