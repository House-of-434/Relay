import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { holdHarnessCapabilities } from "./boot-capabilities.ts";

type EnvFileEntry = string | { path: string; required?: boolean };

describe("trusted mailbox mirror capability", () => {
  it("mounts the mirror secret into the app service only", () => {
    const compose = parse(readFileSync("compose.yaml", "utf8")) as {
      services: Record<string, { env_file?: EnvFileEntry[] }>;
    };
    const files = (service: string): string[] =>
      (compose.services[service]?.env_file ?? []).map((entry) =>
        typeof entry === "string" ? entry : entry.path);

    expect(files("app")).toContain(".env.mirror");
    expect(files("tools")).not.toContain(".env.mirror");
    expect(files("scribe")).not.toContain(".env.mirror");
  });

  it("is held and removed from the harness environment before engines spawn", () => {
    const secret = "mirror-secret-that-is-at-least-thirty-two-bytes";
    const env = { RELAY_MAIL_MIRROR_CAPABILITY: secret } as NodeJS.ProcessEnv;
    const held = holdHarnessCapabilities(env);
    expect(held.mailMirrorCapability).toBe(secret);
    expect(env.RELAY_MAIL_MIRROR_CAPABILITY).toBeUndefined();
  });
});
