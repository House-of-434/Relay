/** Injected before any page script in the capture browser.
 *
 * 1. Installs the remote-audio hook (mirrors every remote WebRTC audio track into
 *    a hidden <audio> element — Meet hides per-participant audio).
 * 2. Taps every audio.srcObject through a 16 kHz AudioContext into one mono
 *    PCM ring the driver drains over CDP. Captures the REMOTE participants.
 *
 * Slice 1 captures the mixed remote stream (speaker = Unknown). Per-channel
 * naming (Vexa's binder / DOM hints) is a later slice. */
import { REMOTE_AUDIO_HOOK } from "./vexa-remote-audio-hook.js";

export const CAPTURE_INIT_SCRIPT = REMOTE_AUDIO_HOOK + String.raw`
(function () {
  if (window.__scribeInstalled) return;
  window.__scribeInstalled = true;

  const CAP_SAMPLES = 16000 * 180;
  let chunks = [];
  let total = 0;
  // Clock: every accepted sample is counted, and the first one anchors wall
  // time. Speaker hints are timestamped on this same clock, so audio ranges and
  // hint ranges cannot drift apart as the buffer drains.
  let samplesFed = 0;
  let anchorWallMs = 0;
  let ctx = null, processor = null;
  const tapped = new WeakSet();

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ sampleRate: 16000 }); } catch (e) { ctx = new AC(); }
    processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0;
    processor.connect(sink); sink.connect(ctx.destination);
    processor.onaudioprocess = function (e) {
      if (total > CAP_SAMPLES) return;
      const ch = e.inputBuffer.getChannelData(0);
      if (samplesFed === 0) anchorWallMs = Date.now();
      chunks.push(new Float32Array(ch));
      total += ch.length;
      samplesFed += ch.length;
    };
    if (ctx.state === "suspended") ctx.resume().catch(function () {});
    return ctx;
  }

  function tap(el) {
    if (!el || tapped.has(el)) return;
    let stream = el.srcObject;
    if (!stream && el.captureStream) { try { stream = el.captureStream(); } catch (e) {} }
    if (!stream || typeof MediaStream === "undefined" || !(stream instanceof MediaStream)) return;
    try {
      ensureCtx();
      const src = ctx.createMediaStreamSource(stream);
      src.connect(processor);
      tapped.add(el);
    } catch (e) {}
  }

  function scan() {
    try { document.querySelectorAll("audio").forEach(tap); } catch (e) {}
  }
  scan();
  setInterval(scan, 1000);

  function sampleRate() {
    return ctx && ctx.sampleRate ? ctx.sampleRate : 16000;
  }

  /** Session-relative clock shared with the speaker-hint observer. */
  function nowMs() {
    if (!anchorWallMs) return Date.now();
    return anchorWallMs + (samplesFed / sampleRate()) * 1000;
  }

  window.__scribePcm = {
    nowMs: nowMs,
    /** Drop everything buffered so far and restart the clock. Called once
     *  admission is confirmed, so waiting-room audio never lands in a segment. */
    reset: function () {
      chunks = [];
      total = 0;
      samplesFed = 0;
      anchorWallMs = 0;
    },
    drain: function () {
      scan();
      if (total === 0) return { b64: "", count: 0, sampleRate: sampleRate(), fromMs: nowMs(), toMs: nowMs() };
      const all = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      chunks = []; const n = total; total = 0;
      const i16 = new Int16Array(all.length);
      for (let i = 0; i < all.length; i++) {
        const s = Math.max(-1, Math.min(1, all[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const bytes = new Uint8Array(i16.buffer);
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      const toMs = nowMs();
      const fromMs = toMs - (n / sampleRate()) * 1000;
      return { b64: btoa(bin), count: n, sampleRate: sampleRate(), fromMs: fromMs, toMs: toMs };
    },
    state: function () {
      return {
        sampleRate: sampleRate(),
        pending: total,
        samplesFed: samplesFed,
        nowMs: nowMs(),
        audioEls: document.querySelectorAll("audio").length,
        mirrored: (window.__vexaMirroredTrackIds && window.__vexaMirroredTrackIds.size) || 0,
      };
    },
  };
})();
`;
