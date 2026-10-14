/** Worker process identity for restart detection.
 *
 * The harness must distinguish "worker restarted, sessions wiped" from "this
 * session never existed": both read as status unknown. Every status answer
 * and /healthz carries this id, generated once per process. A change observed
 * mid-run proves a restart; the harness then fails outstanding captures fast
 * with a clear reason instead of waiting out the reconcile grace window.
 */
import { randomUUID } from "node:crypto";

export const WORKER_BOOT_ID: string = randomUUID();
