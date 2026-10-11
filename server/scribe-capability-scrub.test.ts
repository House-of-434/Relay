/** Boot-hygiene gate: the harness reads its capabilities into memory and deletes
 *  them from the environment BEFORE any engine can spawn, so an engine child —
 *  which inherits the environment through the real spawn seam — can never see
 *  them. Must pass before anyone sets RELAY_SCRIBE_ENABLED=1.
 *
 *  This proves inheritance is closed. It is NOT a boundary: a same-user process
 *  could still read /proc/<pid>/environ (see server/harness-capabilities.ts).
 */
import { describe, expect, it } from "vitest";

import { spawnCli } from "./procs.ts";
import { holdHarnessCapabilities } from "./boot-capabilities.ts";

const CAPABILITY_NAMES = [
  "RELAY_BFF_CAPABILITY",
  "RELAY_SCRIBE_WORKER_CAPABILITY",
  // Must never reach the harness at all; scrubbed defensively if it somehow does.
  "RELAY_INGEST_CAPABILITY",
] as const;

/** Spawn a child through the ACTUAL spawn seam and read back its environment.
 *  `env === undefined` means "inherit this process's environment", exactly as an
 *  engine launched without an explicit env would. */
function dumpChildEnv(env: NodeJS.ProcessEnv | undefined): Promise<Record<string, string | undefined>> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`dump child exited ${String(code)}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as Record<string, string | undefined>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

const expectNoCapabilities = (env: Record<string, string | undefined>): void => {
  for (const name of CAPABILITY_NAMES) expect(env[name], `${name} leaked into the engine`).toBeUndefined();
};

describe("harness capability scrub", () => {
  it("reads the harness capabilities out of the environment and deletes them", () => {
    const env: NodeJS.ProcessEnv = {
      RELAY_BFF_CAPABILITY: "bff-secret",
      RELAY_SCRIBE_WORKER_CAPABILITY: "worker-secret",
      RELAY_INGEST_CAPABILITY: "ingest-should-never-be-here",
      RELAY_MAILBOX_ADDRESS: "relay@example.com",
    };
    const held = holdHarnessCapabilities(env);
    expect(held).toEqual({ bffCapability: "bff-secret", scribeWorkerCapability: "worker-secret" });
    expectNoCapabilities(env);
    // Unrelated variables survive — the scrub is targeted, not a wipe.
    expect(env.RELAY_MAILBOX_ADDRESS).toBe("relay@example.com");
  });

  it("an engine spawned with the scrubbed environment cannot see any capability", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RELAY_BFF_CAPABILITY: "bff-secret",
      RELAY_SCRIBE_WORKER_CAPABILITY: "worker-secret",
      RELAY_INGEST_CAPABILITY: "ingest-should-never-be-here",
      RELAY_SCRIBE_SENTINEL: "keep-me",
    };
    holdHarnessCapabilities(env);

    // A driver that passes the environment object directly…
    const direct = await dumpChildEnv(env);
    expectNoCapabilities(direct);
    expect(direct.RELAY_SCRIBE_SENTINEL).toBe("keep-me");

    // …and one that spreads it (`{ ...process.env }`) both stay clean.
    const spread = await dumpChildEnv({ ...env });
    expectNoCapabilities(spread);
  });

  it("an engine that INHERITS process.env (no explicit env) cannot see any capability", async () => {
    const saved = new Map<string, string | undefined>();
    for (const name of [...CAPABILITY_NAMES, "RELAY_SCRIBE_SENTINEL"]) saved.set(name, process.env[name]);
    try {
      process.env.RELAY_BFF_CAPABILITY = "bff-secret";
      process.env.RELAY_SCRIBE_WORKER_CAPABILITY = "worker-secret";
      process.env.RELAY_INGEST_CAPABILITY = "ingest-should-never-be-here";
      process.env.RELAY_SCRIBE_SENTINEL = "keep-me";
      holdHarnessCapabilities(process.env);

      const inherited = await dumpChildEnv(undefined);
      expectNoCapabilities(inherited);
      expect(inherited.RELAY_SCRIBE_SENTINEL).toBe("keep-me");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
