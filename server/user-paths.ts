import { join } from "node:path";

import { USERS_DIR } from "./config.ts";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalUserId(userId: unknown): userId is string {
  return typeof userId === "string" && USER_ID_PATTERN.test(userId.toLowerCase());
}

export function canonicalUserId(userId: unknown): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("user data requires an authenticated user id");
  }
  const id = userId.toLowerCase();
  if (!isCanonicalUserId(id)) throw new Error("user data requires a UUID user id");
  return id;
}

export function userRoot(userId: unknown): string {
  return join(USERS_DIR, canonicalUserId(userId));
}

export function userWorkspacesDir(userId: unknown): string {
  return join(userRoot(userId), "workspaces");
}

export function userThreadsDir(userId: unknown): string {
  return join(userRoot(userId), "threads");
}
