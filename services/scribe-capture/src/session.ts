import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page } from "playwright";

import type { WorkerConfig } from "./config.js";
import { CAPTURE_INIT_SCRIPT } from "./capture-init.js";
import { REMOTE_AUDIO_HOOK } from "./vexa-remote-audio-hook.js";
import { IngestClient, IngestConflictError } from "./ingest-client.js";
import { SegmentSpool } from "./spool.js";
import { HttpSttClient, float32ToPcm16, pcm16ToWav } from "./stt-client.js";
import { toSegment } from "./gmeet-segment.js";
import { hostAllowed, meetingUrlKey, nativeIdFor } from "./urls.js";
import { describeJoinFailure } from "./errors.js";
import { createNavigationGuard } from "./navigation-guard.js";
import { sharedBrowserContext } from "./shared-browser.js";
import { WORKER_BOOT_ID } from "./boot.js";
import { postMeetDisclosure } from "./chat.js";
import type { CaptureStatus, JoinController, JoinDescriptor, JoinOutcome, MeetingRow, Segment, StatusOutcome } from "./types.js";

/** One confirmed segment from the vendored gmeet pipeline (transcript.v1 view). */
interface GmeetSeg {
  speaker: string;
  speaker_key?: string;
  text: string;
  start: number;
  end: number;
  language?: string | null;
  confidence?: number;
  source?: string;
}
interface GmeetPipeline {
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, ts: number): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
interface VexaGmeetModule {
  createGmeetPipeline(opts: {
    transcribe: (
      pcm: Float32Array,
      prompt?: string,
    ) => Promise<{ text: string; language?: string; segments?: Array<{ start: number; end: number; text: string }> }>;
    sink: { segment: (s: GmeetSeg) => void; draft?: (s: GmeetSeg) => void; finalize: () => void | Promise<void> };
    unknownLabel?: string;
    onError?: (e: unknown) => void;
  }): GmeetPipeline;
}
let vexaGmeetCache: VexaGmeetModule | null = null;
/** Vendored per-channel Meet pipeline, loaded lazily so third-party code stays
 *  out of our typecheck (mirrors loadVexaJoin). */
async function loadGmeetPipeline(): Promise<VexaGmeetModule> {
  if (vexaGmeetCache) return vexaGmeetCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = joinPath(here, "../../../third_party/vexa-capture/core/meetings/modules/gmeet-pipeline/src/index.js");
  vexaGmeetCache = (await import(spec)) as unknown as VexaGmeetModule;
  return vexaGmeetCache;
}



/** The vendored Vexa join layer. Loaded lazily with a computed specifier so it
 * is not pulled into our typecheck (it is third-party code) while still
 * resolving at runtime through tsx. */
interface VexaJoin {
  joinMeeting: (page: unknown, opts: Record<string, unknown>) => Promise<{ admitted: boolean }>;
  leaveGoogleMeet: (page: unknown) => Promise<void>;
  leaveMicrosoftTeams: (page: unknown) => Promise<void>;
  leaveZoomMeeting: (page: unknown) => Promise<void>;
  getJoinBrowserArgs: () => string[];
}
let vexaJoinCache: VexaJoin | null = null;
async function loadVexaJoin(): Promise<VexaJoin> {
  if (vexaJoinCache) return vexaJoinCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = joinPath(here, "../../../third_party/vexa-capture/core/meetings/modules/join/src/index.js");
  vexaJoinCache = (await import(spec)) as unknown as VexaJoin;
  return vexaJoinCache;
}

const VEXA_SCREENSHOT_DIR = "/app/storage/screenshots";

/** Per-channel Meet lane bundle (built by scripts/build-capture.mjs). */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GMEET_BUNDLE = joinPath(HERE, "../dist/gmeet-capture.bundle.js");

interface ProbeFrame {
  t: number;
  channel: number;
  name: string | null;
  energy: number;
}

/** Derive per-channel name-bind transitions from the frame stream (the vendored
 *  binder emits no events; the resolved name per channel IS the binding). */
function discoverBindTransitions(
  frames: ProbeFrame[],
): Array<{ t: number; channel: number; from: string | null; to: string | null }> {
  const last = new Map<number, string | null>();
  const out: Array<{ t: number; channel: number; from: string | null; to: string | null }> = [];
  for (const f of frames) {
    if (!last.has(f.channel)) {
      last.set(f.channel, f.name);
      if (f.name) out.push({ t: f.t, channel: f.channel, from: null, to: f.name });
      continue;
    }
    const prev = last.get(f.channel) ?? null;
    if (prev !== f.name) {
      out.push({ t: f.t, channel: f.channel, from: prev, to: f.name });
      last.set(f.channel, f.name);
    }
  }
  return out;
}

/** Leave using the platform's own flow. */
async function leaveFor(page: Page, platform: string): Promise<void> {
  const vexa = await loadVexaJoin();
  if (platform === "teams") return vexa.leaveMicrosoftTeams(page);
  if (platform === "zoom") return vexa.leaveZoomMeeting(page);
  return vexa.leaveGoogleMeet(page);
}

/** Voice-idle end decision. A meeting with no remote voice is over whether
 * or not tiles agree: leave after VOICE_IDLE_MS of silence once speech was
 * heard, or after FIRST_VOICE_TIMEOUT_MS with nothing ever heard (covers
 * waiting for others who never arrive). Pure logic over timestamps — no
 * browser needed, fully unit-testable. maxMeetingMs remains the hard
 * backstop; non-Meet lanes keep maxMeetingMs only (no per-frame energy). */
export function voiceIdleExpired(args: {
  captureStartMs: number;
  firstVoiceAt: number | null;
  lastVoiceAt: number | null;
  now: number;
}): boolean {
  const { captureStartMs, firstVoiceAt, lastVoiceAt, now } = args;
  if (firstVoiceAt === null) {
    return now - captureStartMs >= FIRST_VOICE_TIMEOUT_MS;
  }
  return lastVoiceAt !== null && now - lastVoiceAt >= VOICE_IDLE_MS;
}

/** Leave after 3 minutes without remote voice; 10 minutes without ever
 * hearing any (waiting room that never fills). */
const VOICE_IDLE_MS = 3 * 60_000;
const FIRST_VOICE_TIMEOUT_MS = 10 * 60_000;
/** Remote-audio energy floor mirroring the capture bundle's silence gate:
 * frames above this prove someone is transmitting. */
const REMOTE_AUDIO_ENERGY = 0.005;

class MeetSession {
  status: CaptureStatus = "joining";
  captureStartedAt: string | null = null;
  error: string | null = null;
  /** Set once the join disclosure was posted to the meeting chat (once per capture). */
  disclosurePosted = false;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private stopped = false;
  private seq = 0;
  private lastEnd = 0;
  private readonly spool: SegmentSpool;
  private readonly stt: HttpSttClient;
  private readonly ingest: IngestClient;
  private gmeet: GmeetPipeline | null = null;
  private captureStartMs = 0;
  /** First and last time a remote frame carried above-silence energy. Drives
   * voice-idle end: the clock starts at first voice; 10 quiet minutes with
   * no voice at all also ends (waiting room that never fills). */
  private firstVoiceAt: number | null = null;
  private lastRemoteAudioAt: number | null = null;
  private probeFrames: ProbeFrame[] = [];
  private probeSegments: Segment[] = [];
  private probeTiles: Array<Record<string, unknown>> = [];
  private probePath: string | null = null;
  private probeStreams = 0;
  private probeDomStart: unknown = null;
  private probeDomEnd: unknown = null;

  constructor(private readonly descriptor: JoinDescriptor, private readonly config: WorkerConfig) {
    this.spool = new SegmentSpool(config.flushSegments, config.flushMs, Date.now());
    this.stt = new HttpSttClient({ baseUrl: config.sttUrl });
    this.ingest = new IngestClient({ url: config.ingestUrl, capability: config.ingestCapability });
  }

  private meetingRow(status: CaptureStatus, extra: Partial<MeetingRow> = {}): MeetingRow {
    const d = this.descriptor;
    return {
      platform: d.platform,
      instance_id: d.instance_id,
      calendar_event_id: d.calendar_event_id ?? null,
      native_id: nativeIdFor(d.platform, d.meeting_url),
      title: d.title ?? null,
      scheduled_start: d.scheduled_start ?? null,
      scheduled_end: d.scheduled_end ?? null,
      actual_start: this.captureStartedAt,
      actual_end: null,
      status,
      error: this.error,
      organizer_email: d.organizer_email ?? null,
      invited_by: d.invited_by ?? null,
      invitees: d.invitees ?? [],
      segment_count: this.spool.added,
      duration_seconds: this.lastEnd > 0 ? this.lastEnd : null,
      disclosure_posted: this.disclosurePosted,
      ...extra,
    };
  }

  private async flush(force: boolean, status: CaptureStatus): Promise<void> {
    const due = force || this.spool.shouldFlush(Date.now());
    if (!due) return;
    const segments = this.spool.drain(Date.now());
    if (segments.length === 0 && !force) return;
    // GATE probe writes no rows: the store contract is already proven, and the
    // probe must not depend on a deployed ingest route.
    if (this.config.gmeetProbe) return;
    try {
      await this.ingest.post(this.meetingRow(status), segments);
    } catch (e) {
      if (e instanceof IngestConflictError) {
        this.status = "skipped";
        this.error = "live meeting conflict";
        this.stopped = true;
        return;
      }
      throw e;
    }
  }

  async run(): Promise<void> {
    try {
      mkdirSync(VEXA_SCREENSHOT_DIR, { recursive: true });
    } catch { /* image provides it; best-effort here */ }

    try {
      const { getJoinBrowserArgs } = await loadVexaJoin();
      const args = getJoinBrowserArgs().filter((a) => a !== "--incognito");
      // Navigation guard first: resolves + validates the meeting host. A
      // violation fails the join here, before any browser exists — never
      // after navigation starts.
      const guard = await createNavigationGuard({
        meetingUrl: this.descriptor.meeting_url,
        log: (message) => console.log(message),
      });
      // One persistent context per worker process: the signed-in profile is
      // single-instance, so a second launchPersistentContext fails on the
      // profile lock. Every capture takes its own tab instead (verified
      // live: one account can sit in two meetings in two tabs).
      this.context = await sharedBrowserContext({
        profileDir: this.config.profileDir,
        headless: this.config.headless,
        args: [...args, "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
          // Headless Chrome has zero media engagement, so programmatic play()
          // on the hook's mirrored <audio> elements is autoplay-blocked without
          // this — the mirrors stay paused, findMedia skips them, and the tap
          // hears digital silence while the room has audio. (Diagnosed live
          // 2026-10-16: frames flowed, every window below the silence gate.)
          "--autoplay-policy=no-user-gesture-required"],
        locale: "en-US",
      });
      // Fresh tab per capture; never reuse a stray about:blank page.
      this.page = await this.context.newPage();
      // Per-page interception before any navigation: every request —
      // initial page, redirect hops, subresources, iframes, popups — is
      // validated pre-flight, so aborts never contact their destination.
      await guard.install(this.page);
      const isMeet = this.descriptor.platform === "google_meet";
      if (isMeet) {
        // Per-channel Meet lane: the remote-audio hook (so elements exist even if
        // Meet hides them — the entry dedupes by audio track id) + the capture
        // bundle. The mixed tap is NOT installed for Meet. Installed per page
        // (was: per context) so Meet and non-Meet captures sharing the browser
        // keep their lanes separate.
        const bundle = this.config.gmeetBundlePath ?? DEFAULT_GMEET_BUNDLE;
        if (!existsSync(bundle)) {
          throw new Error(`gmeet capture bundle missing at ${bundle} — run: pnpm --filter @relay/scribe-capture build:capture`);
        }
        await this.page.addInitScript({ content: REMOTE_AUDIO_HOOK });
        await this.page.addInitScript({ path: bundle });
        await this.page.addInitScript({
          content: `window.__scribeGmeetConfig = ${JSON.stringify({
            selfName: this.config.selfName,
            maxStreams: this.config.maxStreams,
            debug: false,
          })};`,
        });
      } else {
        await this.page.addInitScript({ content: CAPTURE_INIT_SCRIPT });
      }

      this.status = "joining";
      const { joinMeeting } = await loadVexaJoin();
      const result = await joinMeeting(this.page, {
        meetingUrl: this.descriptor.meeting_url,
        platform: this.descriptor.platform,
        botName: "Relay Scribe",
        passcode: this.descriptor.passcode,
        // Join with the persistent (signed-in) profile. Meet needs it (relay@
        // Google session); Zoom is tried authenticated too — its anti-bot wall
        // asks a guest to "sign in to join", so a signed-in web client may pass.
        authenticated: this.descriptor.platform === "google_meet" || this.descriptor.platform === "zoom",
        waitingRoomTimeoutMs: 600_000,
      });
      if (!result.admitted) {
        this.status = "awaiting_admission";
        this.error = "not admitted within the waiting-room timeout";
        await this.finalize("failed");
        return;
      }

      // Time zero is the start of capture.
      this.captureStartedAt = new Date().toISOString();
      this.captureStartMs = Date.now();
      this.status = "active";

      // Join disclosure: once, after admission, Meet only, best-effort. A send
      // failure is recorded (disclosure_posted=false) and never blocks capture.
      if (isMeet && !this.config.gmeetProbe && this.config.disclosure && this.page) {
        const outcome = await postMeetDisclosure(this.page, this.config.disclosure, {
          log: (message) => console.log(message),
        });
        this.disclosurePosted = outcome !== "failed";
        if (outcome === "failed") {
          try {
            const dir = joinPath(this.config.dataDir, "failures");
            mkdirSync(dir, { recursive: true });
            await this.page.screenshot({ path: joinPath(dir, `disclosure-${this.descriptor.instance_id}.png`) });
          } catch {
            /* best effort */
          }
        }
      }
      if (!this.config.gmeetProbe) await this.ingest.post(this.meetingRow("active"), []);

      if (isMeet) {
        await this.gmeetStart();
        if (this.config.gmeetProbe) await this.probeStart();
      }

      const deadline = Date.now() + this.config.maxMeetingMs;
      let endedIdle = false;
      let loopCount = 0;
      while (!this.stopped && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000));
        if (this.stopped) break;
        loopCount += 1;
        if (isMeet) await this.gmeetFeedOnce();
        else await this.captureOnce();
        await this.flush(false, "active");
        if (isMeet && this.config.gmeetProbe) await this.probeTick();
        // Audio-tap health, every ~60s: streams refuge/pending/path/lit plus
        // whether any remote voice has ever crossed the gate. Makes "deaf tap
        // vs quiet room" answerable from worker logs alone.
        if (isMeet && this.status === "active" && loopCount % 10 === 0 && this.page) {
          try {
            const st = await this.page.evaluate(() => (window as any).__scribeGmeet?.state?.() ?? null) as {
              streams: number; pending: number; path: string; lit: string[];
              ctxState: string | null; sampleRate: number | null;
              peaks: Record<number, number>;
              tracks: Array<{ i: number; id: string; muted: boolean | null; ready: string | null; enabled: boolean | null }>;
            } | null;
            const peakStr = st?.peaks ? Object.entries(st.peaks).map(([i, p]) => `${i}:${p}`).join(",") || "-" : "?";
            const trackStr = st?.tracks ? st.tracks.map((t) => `${t.i}:${t.id}${t.muted ? "/muted" : ""}${t.ready && t.ready !== "live" ? `/${t.ready}` : ""}${t.enabled === false ? "/disabled" : ""}`).join(",") || "-" : "?";
            console.log(`scribe: ${this.descriptor.instance_id} tap streams=${st?.streams ?? "?"} pending=${st?.pending ?? "?"} path=${st?.path ?? "?"} lit=${(st?.lit ?? []).join("|") || "-"} ctx=${st?.ctxState ?? "?"}@${st?.sampleRate ?? "?"} peaks=[${peakStr}] tracks=[${trackStr}] firstVoice=${this.firstVoiceAt ? new Date(this.firstVoiceAt).toISOString().slice(11, 19) : "never"} lastVoice=${this.lastRemoteAudioAt ? new Date(this.lastRemoteAudioAt).toISOString().slice(11, 19) : "never"}`);
          } catch {
            /* page may be gone; the loop exits on its own */
          }
        }
        // Voice-idle end (Meet only): no remote voice for 3 minutes means
        // the meeting is over whether or not tiles agree; 10 minutes without
        // ever hearing any covers waiting for others who never arrive.
        // maxMeetingMs remains the hard backstop.
        if (isMeet && this.status === "active" && voiceIdleExpired({
          captureStartMs: this.captureStartMs,
          firstVoiceAt: this.firstVoiceAt,
          lastVoiceAt: this.lastRemoteAudioAt,
          now: Date.now(),
        })) {
          console.log(`scribe: ${this.descriptor.instance_id} ${this.firstVoiceAt ? "no voice for 3m after last voice; leaving" : "never heard any voice for 10m; leaving"}`);
          endedIdle = true;
          break;
        }
      }
      await this.finalize(this.current === "skipped" ? "skipped" : this.stopped && !endedIdle ? "partial" : "completed");
    } catch (e) {
      this.error = describeJoinFailure(e);
      // Never log full URLs: navigation errors can embed meeting ?pwd=.
      console.error(`scribe: ${this.descriptor.instance_id} failed: ${this.error.replace(/([?&]pwd=)[^&\s]*/gi, "$1<redacted>")}`);
      await this.finalize("failed");
    }
  }

  /** Read the field without TS control-flow narrowing it to the last assignment. */
  private get current(): CaptureStatus {
    return this.status;
  }

  private async captureOnce(): Promise<void> {
    if (!this.page) return;
    const drain = await this.page.evaluate(() => (window as any).__scribePcm.drain()) as {
      b64: string; count: number; sampleRate: number;
    };
    if (drain.count < 8000) return; // <0.5s of audio; skip silence jitter
    const pcm = Buffer.from(drain.b64, "base64");
    const chunkSeconds = drain.count / 16_000;
    const startAt = this.lastEnd;
    const endAt = startAt + chunkSeconds;
    this.lastEnd = endAt;
    let text = "";
    try {
      const out = await this.stt.transcribe(pcm16ToWav(pcm));
      text = out.text.trim();
    } catch (e) {
      this.error = e instanceof Error ? e.message.slice(0, 200) : "stt error";
      return;
    }
    if (!text) return;
    this.seq += 1;
    const segment: Segment = {
      segment_key: `turn:${this.seq}`,
      speaker: null,
      start_seconds: Number(startAt.toFixed(2)),
      end_seconds: Number(endAt.toFixed(2)),
      text,
      language: "en",
    };
    this.spool.add(segment);
  }

  // ── Per-channel Meet lane (vendored gmeet-pipeline) ──

  private async gmeetStart(): Promise<void> {
    if (!this.page) return;
    const mod = await loadGmeetPipeline();
    const captureStartSec = this.captureStartMs / 1000;
    const transcribe = async (
      pcm: Float32Array,
    ): Promise<{ text: string; language?: string; segments?: Array<{ start: number; end: number; text: string }> }> => {
      const out = await this.stt.transcribe(pcm16ToWav(float32ToPcm16(pcm)));
      const text = out.text.trim();
      const dur = out.audio_seconds ?? pcm.length / 16_000;
      return { text, language: "en", segments: text ? [{ start: 0, end: dur, text }] : [] };
    };
    const sink = {
      segment: (s: GmeetSeg): void => {
        const seg = toSegment(s, captureStartSec);
        this.spool.add(seg);
        if (this.config.gmeetProbe) this.probeSegments.push(seg);
      },
      draft: (): void => {
        /* MVP persists confirmed segments only */
      },
      finalize: (): void => {
        /* no-op */
      },
    };
    this.gmeet = mod.createGmeetPipeline({
      transcribe,
      sink,
      onError: (e: unknown) => {
        this.error = (e instanceof Error ? e.message : "gmeet pipeline error").slice(0, 200);
      },
    });
    await this.page.evaluate(async () => {
      await (window as any).__scribeGmeet?.start?.();
    });
  }

  private async gmeetFeedOnce(): Promise<void> {
    if (!this.page || !this.gmeet) return;
    let frames: Array<{ channel: number; name: string | null; energy: number; ts: number; pcm?: number[] }>;
    try {
      frames = await this.page.evaluate(() => (window as any).__scribeGmeet?.drain?.(true) ?? []);
    } catch {
      return;
    }
    for (const f of frames) {
      if (typeof f.energy === "number" && f.energy > REMOTE_AUDIO_ENERGY) {
        const at = Date.now();
        if (this.firstVoiceAt === null) this.firstVoiceAt = at;
        this.lastRemoteAudioAt = at;
      }
      if (!f.pcm) continue;
      this.gmeet.feedAudio(f.channel, f.name ?? undefined, Float32Array.from(f.pcm), f.ts);
      if (this.config.gmeetProbe) {
        this.probeFrames.push({
          t: Number(((f.ts - this.captureStartMs) / 1000).toFixed(2)),
          channel: f.channel,
          name: f.name,
          energy: f.energy,
        });
      }
    }
  }

  // ── GATE probe artifact (debug; VPS-local, never committed) ──

  private async probeStart(): Promise<void> {
    if (!this.page) return;
    try {
      this.probeDomStart = await this.page.evaluate(() => (window as any).__scribeGmeet?.probeDom?.() ?? null);
    } catch (e) {
      this.error = (e instanceof Error ? `probe start: ${e.message}` : "probe start failed").slice(0, 200);
    }
  }

  private async probeTick(): Promise<void> {
    if (!this.page) return;
    try {
      const state = (await this.page.evaluate(() => (window as any).__scribeGmeet?.state?.() ?? null)) as
        | { path?: string; streams?: number }
        | null;
      if (state?.path) this.probePath = state.path;
      if (typeof state?.streams === "number") this.probeStreams = state.streams;
      const tiles = await this.page.evaluate(() => (window as any).__scribeGmeet?.tiles?.() ?? { tiles: [], labels: {} });
      this.probeTiles.push({ t: Number(((Date.now() - this.captureStartMs) / 1000).toFixed(2)), ...(tiles as object) });
    } catch {
      /* probe logging must never break capture */
    }
  }

  private async probeFinish(): Promise<void> {
    if (!this.page) return;
    try {
      this.probeDomEnd = await this.page.evaluate(() => (window as any).__scribeGmeet?.probeDom?.() ?? null);
    } catch {
      /* best effort */
    }
    this.writeProbeArtifact();
  }

  private writeProbeArtifact(): void {
    try {
      mkdirSync(this.config.probeDir, { recursive: true });
      const artifact = {
        kind: "scribe-gmeet-probe",
        generated_at: new Date().toISOString(),
        instance_id: this.descriptor.instance_id,
        platform: this.descriptor.platform,
        title: this.descriptor.title ?? null,
        capture_start: this.captureStartedAt,
        duration_seconds: this.lastEnd > 0 ? Number(this.lastEnd.toFixed(1)) : null,
        stream_count: this.probeStreams,
        path: this.probePath,
        bind_transitions: discoverBindTransitions(this.probeFrames),
        segments: this.probeSegments,
        tile_snapshots: this.probeTiles,
        dom_start: this.probeDomStart,
        dom_end: this.probeDomEnd,
        frames: this.probeFrames,
      };
      writeFileSync(
        joinPath(this.config.probeDir, `${this.descriptor.instance_id}.json`),
        JSON.stringify(artifact, null, 2),
      );
    } catch (e) {
      this.error = (e instanceof Error ? `probe artifact: ${e.message}` : "probe artifact failed").slice(0, 200);
    }
  }

  private async finalize(status: CaptureStatus): Promise<void> {
    this.status = status;
    if (this.descriptor.platform === "google_meet" && this.captureStartMs > 0) {
      this.lastEnd = (Date.now() - this.captureStartMs) / 1000;
    }
    try {
      // Flush every open turn through the lane BEFORE the final spool flush, so
      // the meeting's tail is emitted (never lost).
      if (this.gmeet) {
        await this.gmeet.dispose().catch(() => { /* best effort */ });
        this.gmeet = null;
      }
      if (this.page && this.descriptor.platform === "google_meet") {
        try {
          await this.page.evaluate(() => {
            (window as any).__scribeGmeet?.stop?.();
          });
        } catch { /* best effort */ }
      }
      if (this.config.gmeetProbe && this.descriptor.platform === "google_meet") {
        await this.probeFinish();
      }
      if (this.page) {
        try {
          await leaveFor(this.page, this.descriptor.platform);
        } catch { /* best effort */ }
      }
    } finally {
      // Close this capture's tab only. The persistent context is shared by
      // every capture in the worker and outlives any one of them.
      await this.page?.close().catch(() => {});
      this.page = null;
    }
    try {
      await this.flush(true, status);
    } catch (e) {
      this.error = e instanceof Error ? e.message.slice(0, 200) : "final ingest failed";
      this.status = "partial";
    }
  }

  requestStop(): void {
    this.stopped = true;
  }

  outcome(): StatusOutcome {
    return {
      instance_id: this.descriptor.instance_id,
      status: this.status,
      segment_count: this.spool.added,
      capture_started_at: this.captureStartedAt ?? undefined,
      error: this.error ?? undefined,
      worker_boot_id: WORKER_BOOT_ID,
    };
  }

  /** Normalized room identity for cross-instance dedup (see meetingUrlKey). */
  roomKey(): string | null {
    return meetingUrlKey(this.descriptor.platform, this.descriptor.meeting_url);
  }

  /** Live for dedup purposes: states where a browser participant exists or
   * is imminent. Terminal states never block a room. */
  get roomLive(): boolean {
    return this.status === "joining" || this.status === "awaiting_admission" || this.status === "active";
  }
}

/** Cross-instance room dedup, extracted pure for tests: the live instance for
 * a room key, or null. Terminal instances never block. The caller guarantees
 * check-then-insert runs without an intervening await. */
export function selectRoomDuplicate(
  sessions: Array<{ instanceId: string; live: boolean; urlKey: string | null }>,
  urlKey: string | null,
): string | null {
  if (!urlKey) return null;
  return sessions.find((s) => s.live && s.urlKey === urlKey)?.instanceId ?? null;
}

/** Owns one session per instance_id. join is idempotent by instance_id. */
export class SessionController implements JoinController {
  private readonly sessions = new Map<string, MeetSession>();

  constructor(private readonly config: WorkerConfig) {}

  async join(descriptor: JoinDescriptor): Promise<JoinOutcome> {
    const existing = this.sessions.get(descriptor.instance_id);
    if (existing) {
      const s = existing.outcome();
      return { instance_id: s.instance_id, status: s.status, capture_started_at: s.capture_started_at, error: s.error };
    }

    // Reject path: monitor validation failed or we are at capacity — write a
    // failed row without attempting a join.
    let reject = descriptor.reject_reason;
    const live = [...this.sessions.values()].filter((s) => s.status === "joining" || s.status === "awaiting_admission" || s.status === "active").length;
    if (!reject && live >= this.config.maxConcurrent) reject = "at capacity";
    if (!reject && !hostAllowed(descriptor.platform, descriptor.meeting_url)) reject = "meeting host is not an allowed provider domain";
    if (reject) {
      const ingest = new IngestClient({ url: this.config.ingestUrl, capability: this.config.ingestCapability });
      const row: MeetingRow = {
        platform: descriptor.platform,
        instance_id: descriptor.instance_id,
        title: descriptor.title ?? null,
        scheduled_start: descriptor.scheduled_start ?? null,
        scheduled_end: descriptor.scheduled_end ?? null,
        organizer_email: descriptor.organizer_email ?? null,
        invited_by: descriptor.invited_by ?? null,
        invitees: descriptor.invitees ?? [],
        status: "failed",
        error: reject,
        segment_count: 0,
      };
      await ingest.post(row, []).catch(() => { /* surfaced via status below */ });
      return { instance_id: descriptor.instance_id, status: "failed", error: reject };
    }

    // Cross-instance dedup: at most one LIVE capture per room. A second join
    // for a room that is already joining/admitted/active — same calendar
    // event re-armed, a manual request colliding with a calendar arm, or two
    // manual requests racing — returns duplicate instead of seating a second
    // bot. Terminal sessions never block their room. Check-then-insert runs
    // with no await between, so same-process concurrent joins serialize on
    // the event loop; cross-restart duplicates are the harness's reconcile
    // job (armed intents re-post the same instance_id, which dedupes above).
    const roomOwner = selectRoomDuplicate(
      [...this.sessions.entries()].map(([id, s]) => ({ instanceId: id, live: s.roomLive, urlKey: s.roomKey() })),
      meetingUrlKey(descriptor.platform, descriptor.meeting_url),
    );
    if (roomOwner) {
      return { instance_id: descriptor.instance_id, status: "duplicate", error: `room already captured as ${roomOwner}` };
    }

    const session = new MeetSession(descriptor, this.config);
    this.sessions.set(descriptor.instance_id, session);
    void session.run();
    return { instance_id: descriptor.instance_id, status: session.status };
  }

  async status(instanceId: string): Promise<StatusOutcome> {
    const session = this.sessions.get(instanceId);
    if (!session) return { instance_id: instanceId, status: "unknown", segment_count: 0, worker_boot_id: WORKER_BOOT_ID };
    return session.outcome();
  }

  async stop(instanceId: string): Promise<JoinOutcome> {
    const session = this.sessions.get(instanceId);
    if (!session) return { instance_id: instanceId, status: "unknown" };
    session.requestStop();
    const s = session.outcome();
    return { instance_id: s.instance_id, status: s.status, capture_started_at: s.capture_started_at, error: s.error };
  }
}
