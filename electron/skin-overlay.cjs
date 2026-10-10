// The native window chrome that CSS cannot reach, per skin. Everything the
// renderer paints follows `[data-skin]` in src/styles.css; the Windows
// caption-button overlay and the window's own background are drawn by the
// main process and have to be told the same colours. The values mirror each
// skin's `--color-app` (the header strip is `bg-app`) and, for the symbols,
// its `--color-ink-secondary` — flattened to opaque hex because the overlay
// accepts no alpha. Keep in step with src/styles.css and src/lib/skins.ts.
"use strict";

const SKIN_CHROME = Object.freeze({
  lagoon: Object.freeze({ color: "#dfeceb", symbolColor: "#4d5c5b" }),
  midnight: Object.freeze({ color: "#070707", symbolColor: "#b5b5b5" }),
});

const DEFAULT_SKIN = "lagoon";

/** The chrome colours for a skin id sent by the renderer. Anything that is
 * not a known skin — a renamed skin, a stale value, a non-string — falls
 * back to the default rather than throwing, because the renderer has already
 * painted and a wrong overlay is recoverable while a broken IPC is not. */
function skinChrome(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) ? SKIN_CHROME[skin] : SKIN_CHROME[DEFAULT_SKIN];
}

/** True when the id names a skin this module knows. A non-string coerces to a
 * property key that cannot match a skin id, so it answers false without a
 * separate type guard. */
function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin);
}

module.exports = { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin };
