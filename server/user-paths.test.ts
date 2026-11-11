import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { USERS_DIR } from "./config.ts";
import { isCanonicalUserId, userSkillsDir, userWorkspacesDir } from "./user-paths.ts";

const USER = "1bd4480e-8030-4acc-a35e-e859b7091fbf";

describe("user paths", () => {
  it("puts user skills beside (not inside) the per-bot workspaces", () => {
    expect(userSkillsDir(USER)).toBe(join(USERS_DIR, USER, "skills"));
    expect(userWorkspacesDir(USER)).toBe(join(USERS_DIR, USER, "workspaces"));
    expect(userSkillsDir(USER)).not.toContain("workspaces");
  });

  it("rejects non-canonical user ids", () => {
    expect(isCanonicalUserId(USER)).toBe(true);
    expect(isCanonicalUserId("not-a-user")).toBe(false);
    expect(() => userSkillsDir("not-a-user")).toThrow();
  });
});
