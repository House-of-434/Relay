import { describe, expect, it } from "vitest";

import {
  AUTHORIZED_GITHUB_REPO,
  authorizeRelayGitOperation,
  buildRelayGitShell,
  githubWorkspaceEnvironment,
  parseRelayGitCommand,
  redactRelayGitSecret,
  type RelayGitOperation,
} from "./scout-git.ts";

const token = "workspace-token-for-tests";
const branch = "relay/test-event";
const commandFor = (operation: RelayGitOperation): string => {
  if (operation.kind === "auth-status") return "relay-git auth-status";
  if (operation.kind === "clone") return `relay-git clone ${AUTHORIZED_GITHUB_REPO}`;
  if (operation.kind === "checkout") return `relay-git checkout ${operation.branch}`;
  if (operation.kind === "commit") return `relay-git commit "${operation.message}"`;
  if (operation.kind === "push") return `relay-git push ${operation.branch}`;
  return `relay-git create-pr --branch ${operation.branch} --title "${operation.title}" --body "${operation.body}"`;
};

const authorize = (operation: RelayGitOperation, overrides: { senderRole?: string; token?: string | null } = {}) => {
  const parsedCommand = commandFor(operation);
  const parsed = parseRelayGitCommand(parsedCommand);
  if (!parsed.ok) throw new Error(`test command did not parse: ${parsed.error}`);
  return authorizeRelayGitOperation({
    senderRole: overrides.senderRole ?? "scout",
    command: parsedCommand,
    operation: parsed.operation,
    token: overrides.token === undefined ? token : overrides.token,
  });
};

describe("Scout repository command validation", () => {
  it("accepts the complete repository workflow for the authorized repository and relay branch", () => {
    const operations: RelayGitOperation[] = [
      { kind: "auth-status" },
      { kind: "clone", repo: AUTHORIZED_GITHUB_REPO },
      { kind: "checkout", branch },
      { kind: "commit", message: "Add a test event" },
      { kind: "push", branch },
      { kind: "create-pr", branch, title: "Add test event", body: "Verify this test PR." },
    ];
    for (const operation of operations) {
      const parsed = parseRelayGitCommand(commandFor(operation));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.operation).toEqual(operation);
      expect(authorize(operation)).toEqual({ ok: true });
      expect(buildRelayGitShell(operation)).not.toContain(token);
    }
  });

  it("refuses callers other than Scout before allocating or using the token", () => {
    const operation: RelayGitOperation = { kind: "auth-status" };
    const parsed = parseRelayGitCommand(commandFor(operation));
    expect(parsed.ok).toBe(true);
    expect(authorize(operation, { senderRole: "mercury" })).toEqual({
      ok: false,
      status: 403,
      error: "repository operations are available only to Scout",
    });
  });

  it("accepts quoted commit and PR punctuation and keeps it inside shell quoting", () => {
    const commit = parseRelayGitCommand(`relay-git commit "Refresh events; keep Luma link (see Bob's note)"`);
    expect(commit.ok).toBe(true);
    const pr = parseRelayGitCommand(
      `relay-git create-pr --branch ${branch} --title "Refresh events; Luma update" --body "Checked /events; screenshot attached (see Bob's note)."`,
    );
    expect(pr.ok).toBe(true);
    if (commit.ok) {
      expect(authorize(commit.operation)).toEqual({ ok: true });
      expect(buildRelayGitShell(commit.operation)).toContain(`'Refresh events; keep Luma link (see Bob'\\''s note)'`);
    }
    if (pr.ok) {
      expect(authorize(pr.operation)).toEqual({ ok: true });
      const shell = buildRelayGitShell(pr.operation);
      expect(shell).toContain(`'Refresh events; Luma update'`);
      expect(shell).toContain(`'Checked /events; screenshot attached (see Bob'\\''s note).'`);
    }
  });

  it("refuses unauthorized repositories at the execution layer", () => {
    const parsed = parseRelayGitCommand("relay-git clone Other/repository");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        authorizeRelayGitOperation({ senderRole: "scout", command: "relay-git clone Other/repository", operation: parsed.operation, token }),
      ).toEqual({
        ok: false,
        status: 403,
        error: `repository operations are limited to ${AUTHORIZED_GITHUB_REPO}`,
      });
    }
  });

  it("refuses protected branches and branches outside relay/", () => {
    for (const candidate of ["main", "master", "production", "feature/direct"]) {
      const parsed = parseRelayGitCommand(`relay-git push ${candidate}`);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const authorized = authorizeRelayGitOperation({
          senderRole: "scout",
          command: `relay-git push ${candidate}`,
          operation: parsed.operation,
          token,
        });
        expect(authorized.ok).toBe(false);
        if (!authorized.ok) {
          expect(authorized.status).toBe(403);
          expect(authorized.error).not.toContain(token);
        }
      }
    }
  });

  it("refuses repository requests that embed the workspace token", () => {
    const parsed = parseRelayGitCommand(`relay-git commit "${token}"`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        authorizeRelayGitOperation({
          senderRole: "scout",
          command: `relay-git commit "${token}"`,
          operation: parsed.operation,
          token,
        }),
      ).toEqual({
        ok: false,
        status: 400,
        error: "repository commands must not contain the workspace token",
      });
    }
  });

  it("requires a configured token before running an authorized operation", () => {
    const operation: RelayGitOperation = { kind: "auth-status" };
    expect(authorize(operation, { token: null })).toEqual({
      ok: false,
      status: 409,
      error: "the workspace token is not configured",
    });
  });

  it("keeps the workspace token out of generated host commands, logs, and results", () => {
    const environment = githubWorkspaceEnvironment(token);
    expect(environment.GH_TOKEN).toBe(token);
    expect(environment.GITHUB_TOKEN).toBe(token);
    const shell = buildRelayGitShell({ kind: "push", branch });
    expect(shell).toContain("git -C");
    expect(shell).toContain(branch);
    expect(shell).not.toContain(token);
    expect(redactRelayGitSecret(`gh failed: ${token}`, token)).toBe("gh failed: [redacted-secret]");
  });
});
