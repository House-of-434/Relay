/** Per-user browser workspace identity.
 *
 * The actor userId carried by the HMAC-signed actor assertion is the SOLE
 * source of workspace identity. It is canonicalized (lowercase) and
 * validated (UUID) here before any filesystem path is built.
 *
 * Browser tools take no user, path, daemon, or session parameters, and this
 * module accepts no model input: there is no code path by which a model
 * argument can select, traverse into, or collide with a workspace.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Canonical actor user id: lowercase UUID, the same shape the Tool Layer
 * already enforces for actor assertions and database actors. Lowercasing
 * keeps one identity on case-insensitive filesystems. */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalUserId(userId: unknown): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("workspace identity requires an authenticated actor user id");
  }
  const id = userId.toLowerCase();
  if (!USER_ID_PATTERN.test(id)) {
    throw new Error("workspace identity requires a UUID actor user id");
  }
  return id;
}

/** Resolve and validate the workspace data root. The resolved absolute
 * form is returned so later joins cannot escape through `..` or a
 * symlinked prefix in the configured value. */
export function canonicalDataRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("workspace data root must be configured");
  }
  const resolved = resolve(root);
  if (!isAbsolute(resolved)) {
    throw new Error("workspace data root must be absolute");
  }
  return resolved;
}

function assertContained(root: string, candidate: string, what: string): string {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${what} escapes the workspace data root`);
  }
  return candidate;
}

/** The Bladebro data root (BLADE_HOME) for one user's workspace:
 * `<dataRoot>/<userId>`. Profile, saved logins, learned domain knowledge,
 * artifacts, and the behavioral fingerprint all live underneath it, so the
 * agents serving different users never share browser state — while every
 * agent serving the same user shares that user's session. */
export function workspaceRootFor(dataRoot: unknown, userId: unknown): string {
  const root = canonicalDataRoot(dataRoot);
  return assertContained(root, join(root, canonicalUserId(userId)), "workspace root");
}
