/**
 * Meet per-channel capture — page-side glue, bundled into a browser IIFE and injected
 * into the meeting page (see scripts/build-capture.mjs). This is the Relay-side
 * composition that wires the vendored `@vexa/gmeet-capture` bricks together:
 *
 *   createGmeetSpeakers  → who is lit RIGHT NOW (glow), tile-id aware
 *   GmeetChannelBinder   → energy↔glow correlation → per-channel name (or Unknown)
 *   createPcmCaptureNode → AudioWorklet PCM per stream
 *
 * ADAPTATION vs upstream `createGmeetCapture`: ONE shared AudioContext for every
 * stream (upstream creates one per stream, which Chromium caps at ~6 → larger meetings
 * lose audio). The element scan / rescan / track-ended cleanup mirrors upstream; the
 * glow-to-name logic is the vendored binder, unmodified.
 *
 * The remote-audio hook (mirrors remote tracks into hidden <audio> elements) is
 * injected SEPARATELY by the worker (remotaudio hook + this bundle), so this glue just
 * scans media elements either way. `state().path` records which path produced audio.
 *
 * Node drains `window.__scribeGmeet.drain()` (frames: channel + glow name + energy +
 * epoch ts) and feeds the vendored gmeet-pipeline.
 */
import { createPcmCaptureNode, createGmeetSpeakers, GmeetChannelBinder } from "@vexa/gmeet-capture";
import { labelsForTiles, litLabels } from "./gmeet-labels.js";

interface GmeetFrame {
  channel: number;
  name: string | null;
  energy: number;
  ts: number;
  pcm: Float32Array;
}
interface GmeetConfig {
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
  if (g.__scribeGmeet) return;

  const cfg: GmeetConfig = g.__scribeGmeetConfig || {};
  const SR = 16000;
  const SILENCE = cfg.silenceThreshold ?? 0.005;
  const RESCAN = cfg.rescanMs ?? 15000;
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

  const binder = new GmeetChannelBinder({ selfName: cfg.selfName });
  const speakers = createGmeetSpeakers({
    selfName: cfg.selfName,
    pollMs: POLL,
    onSelf: (n: string) => binder.setSelfName(n),
    log: cfg.debug ? (m: string) => log("gmeet-speakers: " + m) : undefined,
  });

  let ctx: any = null;
  const streams = new Map<string, { index: number; src: any; node: any }>();
  let nextIndex = 0;
  let frames: GmeetFrame[] = [];
  let sawDomElement = false;

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
    // Dedupe by AUDIO TRACK id, not stream id: the remote-audio hook (fallback
    // path) mirrors each remote track into a new MediaStream, so the same speaker's
    // audio can appear as two elements with two stream ids but ONE track id.
    // (Probe 2026-10-11: Meet exposed 3 native <audio> + 3 hook mirrors = 6
    // channels for 3 speakers; the duplicate pair thrashed the binder's 1:1 rule.)
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
        const name = binder.nameForChannel(index, now, peak);
        if (frames.length < MAX_FRAMES) frames.push({ channel: index, name: name ?? null, energy: peak, ts: now, pcm });
        try {
          g.__scribeNamedAudioData?.(index, name, pcm, now);
        } catch {
          /* optional hook */
        }
      })
        .then((node: any) => {
          src.connect(node);
          node.connect(c.destination);
          rec.node = node;
        })
        .catch((e: any) => log("gmeet-capture: worklet init failed: " + (e?.message ?? e)));
      stream.getAudioTracks?.()[0]?.addEventListener?.("ended", () => {
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
    const els = findMedia();
    if (els.some((el: any) => !el.dataset || el.dataset.vexaInjected !== "true")) sawDomElement = true;
    for (const el of els) connect(el);
  }

  let prevLit = new Set<string>();

  function pollGlow(): void {
    let tiles: any[] = [];
    try {
      tiles = speakers.getState().tiles;
    } catch {
      return;
    }
    const labels = labelsForTiles(tiles);
    const lit = new Set(litLabels(tiles, labels));
    const now = Date.now();
    for (const l of lit) if (!prevLit.has(l)) binder.recordGlow(l, false, now);
    for (const l of prevLit) if (!lit.has(l)) binder.recordGlow(l, true, now);
    prevLit = lit;
  }

  let rescanTimer: any = null;
  let glowTimer: any = null;

  g.__scribeGmeet = {
    async start(): Promise<void> {
      scan();
      if (!rescanTimer) rescanTimer = setInterval(scan, RESCAN);
      if (!glowTimer) glowTimer = setInterval(pollGlow, POLL);
    },
    stop(): void {
      if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
      }
      if (glowTimer) {
        clearInterval(glowTimer);
        glowTimer = null;
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
    state(): { streams: number; pending: number; path: string; lit: string[] } {
      return {
        streams: streams.size,
        pending: frames.length,
        path: sawDomElement ? "dom" : g.__vexaRemoteAudioHookInstalled ? "hook" : "none",
        lit: [...prevLit],
      };
    },
    probeDom(): unknown {
      try {
        return speakers.probeDom();
      } catch {
        return null;
      }
    },
    tiles(): { tiles: unknown[]; labels: Record<string, string> } {
      try {
        const tiles = speakers.getState().tiles;
        const labels = labelsForTiles(tiles);
        return { tiles, labels: Object.fromEntries(labels) };
      } catch {
        return { tiles: [], labels: {} };
      }
    },
  };
})();
