/** Pure URL helpers for the capture worker (no Playwright, so they unit-test
 * without a browser). Single source of truth lives in
 * packages/meeting-link; this module re-exports the worker-facing names so
 * existing imports keep working. */
export {
  hostAllowed,
  meetCode,
  meetingUrlKey,
  nativeIdFor,
} from "../../../packages/meeting-link/src/index.js";
