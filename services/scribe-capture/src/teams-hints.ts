/** Teams speaker hints — page-side observer, installed next to the mixed tap.
 *
 * Teams mixes all participants into one audio track, so the WebRTC layer cannot
 * say who spoke. The page can: the stage tiles carry a voice-level outline that
 * is switched into `vdi-frame-occlusion` on the tile of the participant Teams is
 * currently rendering as speaking. The participant-info-nametag is the only name
 * source: a tile with nametag text yields that name, a tile without it yields
 * no name.
 *
 * ADAPTED (not imported) from joinly-ai/joinly (MIT):
 *   joinly/providers/browser/platforms/teams.py::_setup_active_speaker_observer
 * We reimplement only the selector + a debounced transition rule, for three
 * reasons the upstream observer does not cover: it emits a single name (we need
 * "nobody" and "ambiguous"), it commits on the first DOM change (Teams flickers),
 * and its timestamps must share the PCM tap's clock.
 *
 * Deliberately NOT a second audio path: this observes only, and stamps every
 * interval with `window.__scribePcm.nowMs()` — the tap's sample clock — so hint
 * ranges and audio ranges cannot drift.
 */

export interface TeamsHintInterval {
  /** Distinct display names lit during the interval; empty = nobody detected,
   *  two or more = ambiguous (overlap or a transition in flight). */
  names: string[];
  fromMs: number;
  toMs: number;
}

export const TEAMS_HINTS_SCRIPT = String.raw`
(function () {
  if (window.__scribeTeamsHints) return;
  var cfg = window.__scribeTeamsHintsConfig || {};
  var SAMPLE_MS = 250;
  /** A transition must hold this many samples (~500ms) before it counts, so a
   *  single repaint or a momentary stomp does not move the speaker boundary. */
  var CONFIRM_SAMPLES = 2;

  var current = [];      // committed set of lit names
  var candidate = null;  // pending set
  var candidateCount = 0;
  var closed = [];       // committed intervals awaiting drain
  var openFrom = null;

  function nowMs() {
    return (window.__scribePcm && window.__scribePcm.nowMs) ? window.__scribePcm.nowMs() : Date.now();
  }

  function litNames() {
    var out = [];
    var tiles = document.querySelectorAll('div[data-tid="stage-layout"] div[role="menuitem"]');
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      // Only the tile(s) Teams is rendering as actively speaking.
      if (!tile.querySelector('div[data-tid="voice-level-stream-outline"].vdi-frame-occlusion')) continue;
      var tag = tile.querySelector('div[data-tid="participant-info-nametag"]');
      var name = tag ? (tag.textContent || "").replace(/\s+/g, " ").trim() : "";
      // The bot's own tile never names a remote speaker.
      if (!name || (cfg.selfName && name.toLowerCase() === String(cfg.selfName).trim().toLowerCase())) continue;
      if (out.indexOf(name) < 0) out.push(name);
    }
    return out.sort();
  }

  function keyOf(names) { return names.join("|"); }

  function tick() {
    var names = litNames();
    var now = nowMs();
    if (openFrom === null) { openFrom = now; current = names; return; }

    var nextKey = keyOf(names);
    if (nextKey === keyOf(current)) { candidate = null; candidateCount = 0; return; }

    if (candidate !== null && nextKey === keyOf(candidate)) {
      candidateCount += 1;
    } else {
      candidate = names;
      candidateCount = 1;
    }
    if (candidateCount < CONFIRM_SAMPLES) return;

    if (now > openFrom) closed.push({ names: current.slice(), fromMs: openFrom, toMs: now });
    current = names;
    openFrom = now;
    candidate = null;
    candidateCount = 0;
  }

  var timer = setInterval(tick, SAMPLE_MS);

  window.__scribeTeamsHints = {
    /** Committed intervals since the last drain, plus the interval still open at
     *  the moment of the call (so the current chunk is covered). */
    drain: function () {
      var out = closed;
      closed = [];
      var now = nowMs();
      if (openFrom !== null && now > openFrom) {
        out.push({ names: current.slice(), fromMs: openFrom, toMs: now });
      }
      return out;
    },
    /** Restart the timeline at admission (discards pre-admission intervals). */
    reset: function () {
      closed = [];
      current = [];
      candidate = null;
      candidateCount = 0;
      openFrom = nowMs();
    },
    stop: function () {
      if (timer) { clearInterval(timer); timer = null; }
    },
    state: function () {
      return { current: current.slice(), openFrom: openFrom, closed: closed.length };
    }
  };
})();
`;
