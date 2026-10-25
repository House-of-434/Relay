/** The vendored Vexa WebRTC remote-audio hook, as an injected page script.
 *
 *  Wraps `RTCPeerConnection` so every remote audio track is mirrored into a
 *  hidden `<audio data-vexa-injected="true">` element. On Meet this guarantees the
 *  media elements exist even when the platform hides per-participant audio from the
 *  DOM; the mixed tap and the per-channel Meet / per-track Zoom lanes all scan those
 *  elements. Extracted from `capture-init.ts` so all paths install one copy.
 *
 *  Origin: Vexa's webrtc-audio-hook (UPSTREAM_COMMIT in third_party/vexa-capture;
 *  the vendored module was removed as unused). Kept inline so the page bundle has
 *  no extra dependency. */
export const REMOTE_AUDIO_HOOK = String.raw`
(function () {
  if (typeof RTCPeerConnection !== "function" || window.__vexaRemoteAudioHookInstalled) return;
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
})();
`;
