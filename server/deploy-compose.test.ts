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
  env_file?: Array<string | { path: string; required?: boolean }>;
  environment?: Record<string, string>;
}
const compose = parse(readFileSync(join(ROOT, "compose.yaml"), "utf8")) as {
  services: Record<string, ComposeService>;
};

const envFiles = (service: string): string[] =>
  (compose.services[service]?.env_file ?? []).map((entry) => typeof entry === "string" ? entry : entry.path);

describe("deploy compose — capability separation", () => {
  it("the harness (app) never loads the ingest capability", () => {
    // The ingest capability must never reach the harness; it is held only by
    // tools + scribe. The scrub test passes trivially if it is never loaded, so
    // this is the check that actually protects the harness.
    expect(envFiles("app")).not.toContain(".env.ingest");
  });

  it("the Git broker uses the shared service capability and is reached over the compose network", () => {
    expect(envFiles("git-broker")).toContain(".env.secrets");
    expect(compose.services.app.environment?.RELAY_GIT_BROKER_URL).toBe("http://git-broker:8792");
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

  it("the tools reach the harness only through the BFF, never directly", () => {
    // The harness edge gate requires a loopback Host, which a compose-network
    // caller can never present — so the scribe-join tool must target the BFF
    // (which terminates tool-facing auth and proxies over loopback), and the
    // harness must stay loopback-bound. Pin both sides of that invariant.
    expect(compose.services.tools.environment?.RELAY_BFF_INTERNAL_URL).toBe("http://app:8798");
    expect(compose.services.tools.environment?.RELAY_HARNESS_INTERNAL_URL).toBeUndefined();
    expect(compose.services.app.environment?.RELAY_HARNESS_HOST).toBeUndefined();
  });
});

describe("deploy image — bundled skills", () => {
  const dockerfile = readFileSync(join(ROOT, "deploy/local/Dockerfile"), "utf8");

  it("copies the bundled skills into the runtime image", () => {
    expect(dockerfile).toContain("COPY --from=build --chown=maus:maus /src/skills ./skills");
  });

  it("fails the build when /app/skills is missing", () => {
    expect(dockerfile).toMatch(/RUN test -d \/app\/skills/);
  });
});
