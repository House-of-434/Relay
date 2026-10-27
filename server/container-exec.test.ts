// containerExec: one shell command in a Local VM, as text, with a real time limit.
import { describe, expect, it } from "vitest";
import { clipExecOutput, containerExec, perBotLocalVmTarget } from "./container-computer.ts";

const target = perBotLocalVmTarget("bot-under-test");

function fakeSecretFiles() {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const contents: string[] = [];
  return {
    written,
    removed,
    contents,
    writeSecretEnvFile: async (path: string, fileContents: string) => {
      written.set(path, fileContents);
      contents.push(fileContents);
    },
    removeSecretEnvFile: async (path: string) => {
      removed.push(path);
      written.delete(path);
    },
  };
}

function fakeExec(result: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
  const exec = async (command: string, args: string[], options: { timeout: number }) => {
    calls.push({ command, args, timeout: options.timeout });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { calls, exec };
}

describe("containerExec", () => {
  it("runs as the desktop user in the durable workspace, with the limit enforced inside the container", async () => {
    const { calls, exec } = fakeExec({ stdout: "hello\n" });
    const result = await containerExec(target, "echo hello", { runtime: "podman", exec, timeoutSeconds: 30 });
    expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("podman");
    expect(calls[0]!.args).toEqual([
      "exec", "-u", "cua", "-w", "/home/cua/workspace", "-e", "HOME=/home/cua", "-e", "DISPLAY=:1",
      target.containerName, "timeout", "-k", "5", "30", "sh", "-lc", "echo hello",
    ]);
    // The client waits a little longer than the in-container limit.
    expect(calls[0]!.timeout).toBe(50_000);
  });

  it("delivers secrets through a temporary env file rather than host process arguments", async () => {
    const token = "workspace-token-for-tests";
    const secrets = fakeSecretFiles();
    const { calls, exec } = fakeExec({ stdout: `active account for ${token}\n`, stderr: `warning for ${token}\n` });
    const result = await containerExec(target, "true", {
      runtime: "docker",
      exec,
      secretEnv: { GH_TOKEN: token, GITHUB_TOKEN: token },
      writeSecretEnvFile: secrets.writeSecretEnvFile,
      removeSecretEnvFile: secrets.removeSecretEnvFile,
    });

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const envFileIndex = args.indexOf("--env-file");
    expect(envFileIndex).toBeGreaterThan(-1);
    const envFile = args[envFileIndex + 1] as string;
    expect(args.join("\n")).not.toContain(token);
    expect(secrets.contents).toEqual([`GH_TOKEN=${token}\nGITHUB_TOKEN=${token}\n`]);
    expect(secrets.removed).toEqual([envFile]);
    expect(secrets.written.size).toBe(0);
    expect(result.stdout).toBe("active account for [redacted-secret]\n");
    expect(result.stderr).toBe("warning for [redacted-secret]\n");
  });

  it("keeps ordinary executions and thrown execution failures free of secrets", async () => {
    const token = "workspace-token-for-tests";
    const { calls, exec } = fakeExec({ stdout: "ordinary output\n" });
    const ordinary = await containerExec(target, "echo hello", { runtime: "podman", exec });
    expect(JSON.stringify(calls[0]!.args)).not.toContain(token);
    expect(calls[0]!.args).not.toContain("--env-file");
    expect(ordinary.stdout).toBe("ordinary output\n");

    const failure = Object.assign(new Error(`client failed with ${token}`), {
      status: 502,
      stdout: `partial ${token}`,
      stderr: "",
    });
    const failingExec = async () => {
      throw failure;
    };
    try {
      await containerExec(target, "true", {
        runtime: "docker",
        exec: failingExec,
        secretEnv: { GH_TOKEN: token },
        ...fakeSecretFiles(),
      });
      throw new Error("secret execution failure was not thrown");
    } catch (error) {
      expect(error).toBe(failure);
      expect((error as Error).message).toBe("client failed with [redacted-secret]");
      expect((error as { status?: unknown }).status).toBe(502);
      expect((error as { stdout?: unknown }).stdout).toBe("partial [redacted-secret]");
    }
  });

  it("returns a failing command's exit code and stderr instead of throwing", async () => {
    const { exec } = fakeExec({ stderr: "ModuleNotFoundError: No module named 'reportlab'\n", code: 1 });
    expect(await containerExec(target, "python3 make.py", { runtime: "docker", exec })).toMatchObject({
      exitCode: 1,
      stderr: "ModuleNotFoundError: No module named 'reportlab'\n",
      timedOut: false,
    });
  });

  it("reports a stopped command as timed out", async () => {
    for (const code of [124, 137]) {
      const { exec } = fakeExec({ code });
      expect(await containerExec(target, "sleep 999", { runtime: "podman", exec, timeoutSeconds: 1 })).toMatchObject({ timedOut: true, exitCode: code });
    }
  });

  it("bounds the time limit and rejects an empty or oversized command", async () => {
    const { calls, exec } = fakeExec();
    await containerExec(target, "true", { runtime: "podman", exec, timeoutSeconds: 99_999 });
    await containerExec(target, "true", { runtime: "podman", exec, timeoutSeconds: -5 });
    expect(calls.map((call) => call.args[calls[0]!.args.indexOf("-k") + 2])).toEqual(["300", "1"]);
    await expect(containerExec(target, "   ", { runtime: "podman", exec })).rejects.toMatchObject({ status: 400 });
    await expect(containerExec(target, "x".repeat(20_001), { runtime: "podman", exec })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
    for (const timeoutSeconds of [NaN, Infinity, -Infinity]) {
      await expect(containerExec(target, "true", { runtime: "podman", exec, timeoutSeconds })).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(2);
  });

  it("keeps the start and the end of a long output, where the error usually is", () => {
    const long = `START${"x".repeat(50_000)}END`;
    const clipped = clipExecOutput(long);
    expect(clipped.length).toBeLessThan(20_100);
    expect(clipped.startsWith("START")).toBe(true);
    expect(clipped.endsWith("END")).toBe(true);
    expect(clipped).toContain("characters omitted");
    expect(clipExecOutput("short")).toBe("short");
  });
});
