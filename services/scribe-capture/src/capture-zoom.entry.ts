/**
 * Zoom per-track capture — page-side glue, bundled into a browser IIFE and injected
 * into the meeting page (see scripts/build-capture.mjs). Mirrors capture-gmeet.entry.ts:
 *
 *   createZoomSpeakers    → who Zoom is rendering as the active speaker (the DOM signal)
 *   createTrackNameResolver → energy ↔ active-speaker correlation → a stable per-track name
 *   createPcmCaptureNode  → AudioWorklet PCM per stream
 *   createZoomChat        → chat panel telemetry (container/candidates state);
 *                             message delivery comes from the adapter row scan below,
 *                             which keys each row by platform id or per-row ordinal
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
import {
  assignRowKeys,
  dropNested,
  platformIdFromAttrs,
  pickStamp,
  resolveFallbackText,
  unionRows,
  type ChatRowIdentity,
} from "./zoom-chat-rows.js";

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

interface ZoomChatRow {
  sender: string;
  text: string;
  ts: number;
  ordinal: number;
  message_id?: string;
  stamp?: string;
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

  // Inbound chat, observed row by row in this adapter. Each row is identified
  // at first sight by the platform message id when the row genuinely carries
  // one, else by its content (sender, text, and row timestamp attribute when
  // present), else by its ordinal among the currently rendered rows plus its
  // text. A rebuilt list re-rendering the same messages yields the same keys,
  // so a re-poll delivers nothing; a recycled node showing a new message
  // yields a new key.
  const chatMessages: ZoomChatRow[] = [];
  const deliveredChatKeys = new Set<string>();
  const deliveredChatOrder: string[] = [];
  const DELIVERED_CHAT_LIMIT = 2000;
  const chatDrops: Record<string, number> = {};

  function markChatDelivered(key: string): void {
    if (deliveredChatKeys.has(key)) return;
    deliveredChatKeys.add(key);
    deliveredChatOrder.push(key);
    if (deliveredChatOrder.length > DELIVERED_CHAT_LIMIT) {
      const oldest = deliveredChatOrder.shift();
      if (oldest !== undefined) deliveredChatKeys.delete(oldest);
    }
  }

  const CHAT_ROW_SELECTORS = [
    '[id^="chat-message-"]',
    ".new-chat-message__container",
    '[class*="chat-message-item"]',
    '[class*="chatMessage"]',
    "div[data-index]",
  ];
  const CHAT_SENDER_SELECTORS = [
    ".chat-message-text__user-name",
    '[class*="user-name"]',
    '[class*="userName"]',
    '[class*="sender"]',
    '[class*="display-name"]',
  ];
  const CHAT_TEXT_SELECTORS = [
    '[class*="chat-message-text"]',
    '[class*="message-text"]',
    '[class*="messageText"]',
    ".text-wrapper",
    '[class*="text-content"]',
  ];

  function chatRowText(root: Element, selectors: string[]): string {
    for (const sel of selectors) {
      const t = root.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return "";
  }

  function chatRowPlatformId(row: Element): string | null {
    const own = platformIdFromAttrs({
      id: row.getAttribute("id"),
      mid: row.getAttribute("data-mid"),
      messageId: row.getAttribute("data-message-id"),
    });
    if (own) return own;
    const desc = row.querySelector('[id^="chat-message-"],[data-mid],[data-message-id]');
    if (!desc || desc === row) return null;
    return platformIdFromAttrs({
      id: desc.getAttribute("id"),
      mid: desc.getAttribute("data-mid"),
      messageId: desc.getAttribute("data-message-id"),
    });
  }

  function chatRowStamp(row: Element): string | null {
    const time = row.querySelector("time[datetime]");
    return pickStamp([
      row.getAttribute("data-time"),
      row.getAttribute("data-timestamp"),
      row.getAttribute("data-ts"),
      row.getAttribute("data-created"),
      row.getAttribute("data-created-at"),
      time?.getAttribute("datetime") ?? null,
    ]);
  }

  function normalizeSender(sender: string): string {
    return sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, "").trim();
  }

  function readChatRow(row: Element): { sender: string; text: string } | { drop: "no-text" | "unseparable" } {
    const textHit = chatRowText(row, CHAT_TEXT_SELECTORS);
    let sender = chatRowText(row, CHAT_SENDER_SELECTORS);
    let senderFound = sender.length > 0;
    if (!senderFound) {
      let cur = row.parentElement;
      for (let i = 0; i < 4 && cur && !senderFound; i++, cur = cur.parentElement) {
        sender = chatRowText(cur, CHAT_SENDER_SELECTORS);
        senderFound = sender.length > 0;
      }
    }
    if (!senderFound) {
      let cur: Element | null = row;
      for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
        const label = cur.getAttribute("aria-label") || "";
        const m = label.match(/^(.+?)\s+(?:said|to\s+Everyone|to\s+[A-Z])/i);
        if (m && m[1].trim()) {
          sender = m[1].trim();
          senderFound = true;
          break;
        }
      }
    }
    if (textHit) {
      return { sender: normalizeSender(sender) || "Unknown", text: textHit };
    }
    const frags = Array.from(row.querySelectorAll("*"))
      .map((e) => (e.childElementCount === 0 ? (e.textContent || "").trim() : ""))
      .filter((t) => t.length > 0);
    if (!frags.length) return { drop: "no-text" };
    const clean = normalizeSender(sender);
    const text = resolveFallbackText(frags, clean, senderFound);
    if (!text) return { drop: "unseparable" };
    return { sender: clean || "Unknown", text };
  }

  function scanChatRows(): void {
    const rows = dropNested(
      unionRows(CHAT_ROW_SELECTORS.map((sel) => Array.from(document.querySelectorAll(sel)))),
      (r) => r.parentElement,
    );
    const identities: ChatRowIdentity[] = [];
    const parsed: Array<{ sender: string; text: string }> = [];
    rows.forEach((row, index) => {
      const result = readChatRow(row);
      if ("drop" in result) {
        chatDrops[result.drop] = (chatDrops[result.drop] ?? 0) + 1;
        log(`chat row dropped (${result.drop})`);
        return;
      }
      parsed.push(result);
      identities.push({
        platformId: chatRowPlatformId(row),
        stamp: chatRowStamp(row),
        index,
        sender: result.sender,
        text: result.text,
      });
    });
    const keys = assignRowKeys(identities);
    for (let i = 0; i < parsed.length; i++) {
      const key = keys[i];
      if (deliveredChatKeys.has(key)) continue;
      const identity = identities[i];
      const entry: ZoomChatRow = { sender: parsed[i].sender, text: parsed[i].text, ts: Date.now(), ordinal: identity.index };
      if (identity.platformId) entry.message_id = identity.platformId;
      if (identity.stamp) entry.stamp = identity.stamp;
      chatMessages.push(entry);
      markChatDelivered(key);
      try {
        g.__scribeZoomChat?.(parsed[i].sender, parsed[i].text, Date.now());
      } catch {
        /* optional host hook */
      }
    }
  }

  // The vendored reader stays attached for its container/candidate telemetry
  // (see state().chatState); delivery comes from the row scan above.
  const chat = createZoomChat({
    log: cfg.debug ? (m: string) => log("zoom-chat: " + m) : undefined,
    onMessage: () => {},
  });
  scanChatRows();
  const chatPoll = setInterval(scanChatRows, 2000);

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
        clearInterval(chatPoll);
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
    /** Inbound chat since the last drain, each row with a stable identity. */
    drainChat(): ZoomChatRow[] {
      scanChatRows();
      return chatMessages.splice(0, chatMessages.length);
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
        chatDrops: { ...chatDrops },
        hook: {
          injected: (g.__vexaInjectedAudioElements ?? []).length,
          mirroredTracks: g.__vexaMirroredTrackIds?.size ?? 0,
        },
      };
    },
  };
})();
