/** Injected before any page script in the capture browser.
 *
 * 1. Mirrors every remote WebRTC audio track into a hidden <audio> element
 *    (the vendored Vexa hook, inlined — Meet hides per-participant audio).
 * 2. Taps every audio.srcObject through a 16 kHz AudioContext into one mono
 *    PCM ring the driver drains over CDP. Captures the REMOTE participants.
 *
 * Slice 1 captures the mixed remote stream (speaker = Unknown). Per-channel
 * naming (Vexa's binder / DOM hints) is a later slice. */
export const CAPTURE_INIT_SCRIPT = String.raw`
(function () {
  if (window.__scribeInstalled) return;
  window.__scribeInstalled = true;

  try {
    if (typeof RTCPeerConnection === "function" && !window.__vexaRemoteAudioHookInstalled) {
      window.__vexaRemoteAudioHookInstalled = true;
      window.__vexaMirroredTrackIds = new Set();
      const OriginalPC = RTCPeerConnection;
      const handleTrack = function (event) {
        try {
          if (!event.track || event.track.kind !== "audio") return;
          if (window.__vexaMirroredTrackIds.has(event.track.id)) return;
          window.__vexaMirroredTrackIds.add(event.track.id);
          const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
          const el = document.createElement("audio");
          el.autoplay = true; el.muted = false; el.volume = 1.0;
          el.dataset.vexaInjected = "true";
          el.style.position = "absolute"; el.style.left = "-9999px";
          el.style.width = "1px"; el.style.height = "1px";
          el.srcObject = stream;
          if (el.play) el.play().catch(function () {});
          (document.body || document.documentElement).appendChild(el);
        } catch (e) {}
      };
      function WrappedPC() {
        const pc = new OriginalPC(...arguments);
        pc.addEventListener("track", handleTrack);
        return pc;
      }
      WrappedPC.prototype = OriginalPC.prototype;
      try { window.RTCPeerConnection = WrappedPC; } catch (e) {}
    }
  } catch (e) {}

  const CAP_SAMPLES = 16000 * 180;
  let chunks = [];
  let total = 0;
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
      chunks.push(new Float32Array(ch));
      total += ch.length;
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

  window.__scribePcm = {
    drain: function () {
      scan();
      if (total === 0) return { b64: "", count: 0, sampleRate: ctx ? ctx.sampleRate : 0 };
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
      return { b64: btoa(bin), count: n, sampleRate: ctx ? ctx.sampleRate : 0 };
    },
    state: function () {
      return {
        sampleRate: ctx ? ctx.sampleRate : 0,
        pending: total,
        audioEls: document.querySelectorAll("audio").length,
        mirrored: (window.__vexaMirroredTrackIds && window.__vexaMirroredTrackIds.size) || 0,
      };
    },
  };
})();
`;
