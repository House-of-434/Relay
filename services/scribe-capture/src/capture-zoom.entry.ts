/**
 * Zoom per-track capture — page-side glue, bundled into a browser IIFE and injected
 * into the meeting page (see scripts/build-capture.mjs). Mirrors capture-gmeet.entry.ts:
 *
 *   createZoomSpeakers    → who Zoom is rendering as the active speaker (the DOM signal)
 *   createTrackNameResolver → energy ↔ active-speaker correlation → a stable per-track name
 *   createPcmCaptureNode  → AudioWorklet PCM per stream
 *   createZoomChat        → in-meeting chat messages
 *
 * Zoom's audio arrives as ONE WebRTC audio track per participant (verified live: three
 * native `zoom-audio-tag-N` elements, three distinct live tracks), so the per-track lane
 * needs no diarizer — only the name binding. Naming is the hard part because Zoom's
 * active-speaker DOM is a sticky spotlight that lags and holds the wrong person under
 * screen share; `createTrackNameResolver` is Vexa's pure vote/hysteresis/purity/1:1/self
 * algorithm for exactly that, golden-tested at
 * third_party/vexa-capture/core/meetings/modules/zoom-capture/src/track-name-resolver.golden.test.ts.
 *
 * The remote-audio hook is injected separately by the worker, so the same speaker can
 * appear twice in the DOM (native element + hook mirror). We dedupe by AUDIO TRACK id,
 * exactly like the Meet glue: both views share one track id, so they collapse to one
 * channel and cannot thrash the resolver's 1:1 rule.
 */
import { createPcmCaptureNode } from "@vexa/gmeet-capture";
import { createTrackNameResolver, createZoomChat, createZoomSpeakers } from "@vexa/zoom-capture";

interface ZoomFrame {
  channel: number;
  name: string | null;
  energy: number;
  ts: number;
  pcm: Float32Array;
}

interface ZoomConfig {
  selfName?: string;
  debug?: boolean;
  pollMs?: number;
  rescanMs?: number;
  silenceThreshold?: number;
  maxFrames?: number;
  maxStreams?: number;
}

(function () {
  const g = globalThis as any;
  if (g.__scribeZoom) return;

  const cfg: ZoomConfig = g.__scribeZoomConfig || {};
  const SR = 16000;
  const SILENCE = cfg.silenceThreshold ?? 0.005;
  const RESCAN = cfg.rescanMs ?? 5000;
  const POLL = cfg.pollMs ?? 250;
  const MAX_FRAMES = cfg.maxFrames ?? 4000;
  const MAX_STREAMS = cfg.maxStreams ?? 12;
  const log = (m: string): void => {
    if (cfg.debug) {
      try {
        g.__scribeLog?.(m);
      } catch {
        /* logging must never break capture */
      }
    }
  };

  const resolver = createTrackNameResolver({
    mode: "exclusive",
    selfName: cfg.selfName,
    onBind: (channel: number, name: string, votes: number) => {
      try {
        g.__scribeZoomBind?.(channel, name, votes);
      } catch {
        /* optional host hook */
      }
      log(`bound ch=${channel} -> ${name} (${votes} votes)`);
    },
  });

  const speakers = createZoomSpeakers({
    selfName: cfg.selfName,
    pollMs: POLL,
    onSpeakerChange: (name: string | null) => {
      resolver.onSpeak(name, Date.now(), name === null);
    },
    log: cfg.debug ? (m: string) => log("zoom-speakers: " + m) : undefined,
  });

  const chatMessages: Array<{ sender: string; text: string; ts: number }> = [];
  const chat = createZoomChat({
    log: cfg.debug ? (m: string) => log("zoom-chat: " + m) : undefined,
    onMessage: (msg: { sender: string; text: string }) => {
      chatMessages.push({ sender: msg.sender, text: msg.text, ts: Date.now() });
      try {
        g.__scribeZoomChat?.(msg.sender, msg.text, Date.now());
      } catch {
        /* optional host hook */
      }
    },
  });

  let ctx: any = null;
  const streams = new Map<string, { index: number; src: any; node: any }>();
  let nextIndex = 0;
  let frames: ZoomFrame[] = [];

  function ensureCtx(): any {
    if (ctx) return ctx;
    const AC = g.AudioContext || g.webkitAudioContext;
    ctx = new AC({ sampleRate: SR });
    Promise.resolve(ctx.resume?.()).catch(() => {});
    return ctx;
  }

  function findMedia(): any[] {
    return Array.from(document.querySelectorAll("audio, video")).filter(
      (el: any) => !el.paused && el.srcObject && (el.srcObject.getAudioTracks?.().length || 0) > 0,
    );
  }

  function connect(el: any): void {
    const stream = el.srcObject;
    const track = stream.getAudioTracks?.()[0];
    const id: string = track?.id || stream.id;
    if (streams.has(id)) return;
    if (streams.size >= MAX_STREAMS) {
      log("stream cap reached (" + MAX_STREAMS + "), ignoring " + String(id).slice(0, 8));
      return;
    }
    const index = nextIndex++;
    try {
      const c = ensureCtx();
      const src = c.createMediaStreamSource(stream);
      const rec = { index, src, node: null as any };
      streams.set(id, rec);
      createPcmCaptureNode(c, (pcm: Float32Array) => {
        const now = Date.now();
        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
          const a = Math.abs(pcm[i]);
          if (a > peak) peak = a;
        }
        if (peak <= SILENCE) return;
        resolver.markHot(index, now, peak);
        const name = resolver.resolve(index, now);
        if (frames.length < MAX_FRAMES) {
          frames.push({ channel: index, name: name ?? null, energy: peak, ts: now, pcm });
        }
        try {
          g.__scribeZoomNamedAudio?.(index, name, pcm, now);
        } catch {
          /* optional hook */
        }
      })
        .then((node: any) => {
          src.connect(node);
          node.connect(c.destination);
          rec.node = node;
        })
        .catch((e: any) => log("zoom-capture: worklet init failed: " + (e?.message ?? e)));
      track?.addEventListener?.("ended", () => {
        try {
          src.disconnect();
        } catch {
          /* torn down */
        }
        streams.delete(id);
      });
      log("stream " + index + " connected (" + String(id).slice(0, 8) + ")");
    } catch (e: any) {
      log("stream " + index + " error: " + (e?.message ?? e));
    }
  }

  function scan(): void {
    for (const el of findMedia()) connect(el);
  }

  let rescanTimer: any = null;

  g.__scribeZoom = {
    async start(): Promise<void> {
      scan();
      if (!rescanTimer) rescanTimer = setInterval(scan, RESCAN);
    },
    stop(): void {
      if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
      }
      for (const [, r] of streams) {
        try {
          r.src?.disconnect();
          r.node?.disconnect?.();
        } catch {
          /* best effort */
        }
      }
      streams.clear();
      try {
        speakers.destroy();
      } catch {
        /* best effort */
      }
      try {
        chat.destroy();
      } catch {
        /* best effort */
      }
      try {
        ctx?.close?.();
      } catch {
        /* best effort */
      }
      ctx = null;
    },
    drain(includePcm = true): Array<{ channel: number; name: string | null; energy: number; ts: number; pcm?: number[] }> {
      const snapshot = frames;
      frames = [];
      return snapshot.map((f) => ({
        channel: f.channel,
        name: f.name,
        energy: Number(f.energy.toFixed(4)),
        ts: f.ts,
        ...(includePcm ? { pcm: Array.from(f.pcm) } : {}),
      }));
    },
    /** Inbound chat since the last drain. */
    drainChat(): Array<{ sender: string; text: string; ts: number }> {
      const snapshot = chatMessages.splice(0, chatMessages.length);
      return snapshot;
    },
    state(): Record<string, unknown> {
      let speakerState: unknown = null;
      try {
        speakerState = speakers.getState();
      } catch {
        speakerState = null;
      }
      let chatState: unknown = null;
      try {
        chatState = chat.getState();
      } catch {
        chatState = null;
      }
      const channels = (() => {
        try {
          return resolver.channels();
        } catch {
          return [];
        }
      })();
      return {
        streams: streams.size,
        pending: frames.length,
        active: (() => {
          try {
            return speakers.getActiveSpeaker();
          } catch {
            return null;
          }
        })(),
        channels,
        labels: Object.fromEntries(channels.map((c: number) => [c, resolver.labelFor(c)])),
        speakerState,
        chatState,
        hook: {
          injected: (g.__vexaInjectedAudioElements ?? []).length,
          mirroredTracks: g.__vexaMirroredTrackIds?.size ?? 0,
        },
      };
    },
  };
})();
