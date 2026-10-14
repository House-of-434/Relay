/** Capability separation is a deployment property, not just code: the harness
 *  container must never be handed the ingest capability, and the worker must be
 *  reachable over the compose network (not loopback). A later compose edit could
 *  quietly break either, and both fail silently at runtime — so pin them here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ComposeService {
  env_file?: string[];
  environment?: Record<string, string>;
}
const compose = parse(readFileSync(join(ROOT, "compose.yaml"), "utf8")) as {
  services: Record<string, ComposeService>;
};

const envFiles = (service: string): string[] => compose.services[service]?.env_file ?? [];

describe("deploy compose — capability separation", () => {
  it("the harness (app) never loads the ingest capability", () => {
    // The ingest capability must never reach the harness; it is held only by
    // tools + scribe. The scrub test passes trivially if it is never loaded, so
    // this is the check that actually protects the harness.
    expect(envFiles("app")).not.toContain(".env.ingest");
  });

  it("the harness loads the worker capability (to arm captures)", () => {
    expect(envFiles("app")).toContain(".env.scribe");
  });

  it("tools holds the ingest capability and never the worker capability", () => {
    expect(envFiles("tools")).toContain(".env.ingest");
    expect(envFiles("tools")).not.toContain(".env.scribe");
  });

  it("scribe holds both capabilities", () => {
    expect(envFiles("scribe")).toEqual(expect.arrayContaining([".env.ingest", ".env.scribe"]));
  });

  it("the harness reaches the worker over the compose network, not loopback", () => {
    // 127.0.0.1 inside the app container points at the app itself; a loopback
    // worker URL fails silently as "worker unreachable" (every armed meeting
    // then routes to the terminal-notice path).
    expect(compose.services.app.environment?.RELAY_SCRIBE_WORKER_URL).toBe("http://scribe:8791");
  });

  it("the tools reach the harness over the compose network, not loopback", () => {
    // Same failure mode as the worker URL above, for the scribe-join tool:
    // a loopback harness URL inside the tools container points at tools
    // itself, and every join request fails as "unreachable".
    expect(compose.services.tools.environment?.RELAY_HARNESS_INTERNAL_URL).toBe("http://app:8799");
  });

  it("the harness binds its container interface for compose callers", () => {
    // The harness listens on loopback by default (bare processes stay
    // single-host); compose must override the bind or the tools container
    // cannot reach the internal routes at all. The port stays unpublished.
    expect(compose.services.app.environment?.RELAY_HARNESS_HOST).toBe("0.0.0.0");
  });
});
