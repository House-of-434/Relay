/** Scribe monitor — the harness side of the capture workflow.
 *
 * Every tick it gathers JoinRequests from its producers (relay@'s calendar
 * over the BFF internal route today; manual join requests next), and for each
 * request past due it builds a descriptor and posts it to the worker's /join
 * endpoint. Arming is idempotent through a command receipt keyed on
 * instance_id|event_start, so a restart never double-arms and a reschedule
 * re-arms at the new time.
 *
 * Receipt order is check -> POST -> write: the POST cannot live inside the
 * synchronous receipt transaction, so a crash between the two just re-posts
 * onto the worker's idempotent /join. The monitor holds no database key.
 *
 * Timer shape follows server/calendar-calls.ts (injected deps, setInterval,
 * ticking guard, start/stop).
 */

export interface CalendarEventTime {
  dateTime?: string;
  date?: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  status?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string; passcode?: string }> };
  description?: string;
  location?: string;
  organizer?: { email?: string };
  creator?: { email?: string };
  attendees?: Array<{ email?: string }>;
  recurringEventId?: string;
}

export interface ScribeDescriptor {
  instance_id: string;
  platform: "google_meet" | "zoom" | "teams";
  meeting_url: string;
  passcode?: string;
  title?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  organizer_email?: string;
  invited_by?: string;
  invitees?: string[];
  calendar_event_id?: string;
  /** Resolved owner for the row: the requesting member's UUID on a manual join,
   *  carried straight through to transcripts.meetings.organizer_user_id. Set
   *  only when known; calendar joins leave it unset and let ingest resolve
   *  organizer_email → member. */
  organizer_user_id?: string;
}

/** Idempotency store for arm/notify receipts. Real impl wraps message-db. */
export interface ReceiptStore {
  has(kind: string, key: string): boolean;
  record(kind: string, key: string, result: string, at: number): void;
}

/** The worker's /status answer for one instance. worker_boot_id identifies the
 * worker generation (capture worker boot.ts): a change observed mid-run
 * proves a worker restart, which wipes its in-memory sessions. Absent from
 * older workers and test fakes — then only the grace path applies. */
export interface ScribeWorkerStatus {
  status: string;
  segment_count?: number;
  error?: string;
  worker_boot_id?: string;
}

/** A terminal notice handed to the harness to email. The monitor decides the
 *  kind and the recipients (organizer-first-known-member, admins on signed-out);
 *  the harness owns the actual send. */
export interface ScribeNotice {
  instance_id: string;
  kind: "completed" | "failed" | "unreachable";
  reason?: string;
  /** True when the failure is a signed-out profile, so admins must be told to
   *  re-authenticate (in addition to the organizer's plain notice). */
  signedOut: boolean;
  title?: string;
  organizer_email?: string;
  creator_email?: string;
  scheduled_end?: string;
  segment_count?: number;
}

export interface ScribeMonitorDeps {
  listEvents: (timeMinIso: string, timeMaxIso: string) => Promise<CalendarEvent[]>;
  joinWorker: (descriptor: ScribeDescriptor) => Promise<{ status: string }>;
  /** The worker /status; used to reconcile armed meetings into a notice. */
  status: (instanceId: string) => Promise<ScribeWorkerStatus>;
  receipts: ReceiptStore;
  /** Manual join intents due for arming (durable store drain). Absent in
   * calendar-only operation — the calendar path never touches this. */
  listManualRequests?: () => Promise<JoinRequest[]>;
  /** Flip an armed manual intent pending → armed. Absent mirrors absent list. */
  noteManualArmed?: (instanceId: string) => void;
  /** Mark a manual intent terminal once its notice is recorded. Durable end
   * of the intent lifecycle: only then may the same room be captured again. */
  noteManualTerminal?: (instanceId: string) => void;
  /** Sent from the harness on a terminal meeting state (or a joinable meeting
   *  that never reached the worker). The harness owns the email wiring. */
  notify?: (notice: ScribeNotice) => void | Promise<void>;
  /** relay@'s own address; meetings it organizes are skipped quietly. */
  selfAddress?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ScribeMonitorConfig {
  pollMs: number;
  windowBackMs: number;
  windowForwardMs: number;
  /** Join at start minus this. */
  armLeadMs: number;
  /** Accept a start up to this late. */
  lateMaxMs: number;
  /** Manual joins arm immediately when accepted; past created_at + this with
   * no arm receipt they are terminally unreachable. */
  manualLateMs: number;
  maxResults: number;
  /** After scheduled_end, give the worker record this long before giving up on
   *  reconciliation (write the receipt, log, stop polling). */
  reconcileGraceMs: number;
  /** Rate limit for signed-out admin alerts (one per this window). */
  adminAlertIntervalMs: number;
}

/** Terminal capture states (per §6.9): completed/partial → ready, failed →
 *  failure, skipped → quiet. */
export const TERMINAL_SCRIBE_STATES = ["completed", "partial", "failed", "skipped"] as const;

/** The worker's signed-out reason (services/scribe-capture/src/errors.ts). */
export function isSignedOutReason(error: string | undefined): boolean {
  return typeof error === "string" && /signed out/i.test(error);
}

export function scribeMonitorConfig(env: NodeJS.ProcessEnv = process.env): ScribeMonitorConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    pollMs: num(env.RELAY_SCRIBE_POLL_MS, 60_000),
    windowBackMs: num(env.RELAY_SCRIBE_WINDOW_BACK_MS, 24 * 60 * 60 * 1000),
    windowForwardMs: num(env.RELAY_SCRIBE_WINDOW_FORWARD_MS, 24 * 60 * 60 * 1000),
    armLeadMs: num(env.RELAY_SCRIBE_ARM_LEAD_MS, 60_000),
    lateMaxMs: num(env.RELAY_SCRIBE_LATE_MAX_MS, 5 * 60 * 1000),
    manualLateMs: num(env.RELAY_SCRIBE_MANUAL_LATE_MS, 5 * 60 * 1000),
    maxResults: num(env.RELAY_SCRIBE_MAX_RESULTS, 250),
    reconcileGraceMs: num(env.RELAY_SCRIBE_RECONCILE_GRACE_MS, 30 * 60 * 1000),
    adminAlertIntervalMs: num(env.RELAY_SCRIBE_ADMIN_ALERT_INTERVAL_MS, 3 * 60 * 60 * 1000),
  };
}

const PROVIDER_HOSTS: Array<{ platform: ScribeDescriptor["platform"]; test: (host: string) => boolean }> = [
  { platform: "google_meet", test: (h) => h === "meet.google.com" },
  { platform: "zoom", test: (h) => h === "zoom.us" || h.endsWith(".zoom.us") },
  { platform: "teams", test: (h) => h === "teams.microsoft.com" || h === "teams.live.com" },
];

const URL_IN_TEXT = /https?:\/\/(?:meet\.google\.com|[\w-]+\.zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'<>]+/i;

/** Platform for a meeting URL, or null when the host is not a provider. */
export function platformForUrl(url: string): ScribeDescriptor["platform"] | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const p of PROVIDER_HOSTS) if (p.test(host)) return p.platform;
  return null;
}

/** The join URL from a calendar event: video entry point, then hangoutLink,
 * then the first provider URL found in description/location. */
export function meetingUrlFor(event: CalendarEvent): string | null {
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && typeof e.uri === "string" && e.uri.startsWith("http"),
  );
  if (video?.uri) return video.uri;
  if (typeof event.hangoutLink === "string" && event.hangoutLink.startsWith("http")) return event.hangoutLink;
  for (const text of [event.description, event.location]) {
    if (typeof text !== "string") continue;
    const match = URL_IN_TEXT.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** Event start in ms, or null for an all-day / unparseable event. */
/** Event end in ms, or null when absent/unparseable. */
export function eventEndMs(event: Pick<CalendarEvent, "end">): number | null {
  const dt = event.end?.dateTime;
  if (typeof dt !== "string") return null;
  const ms = Date.parse(dt);
  return Number.isFinite(ms) ? ms : null;
}

export function eventStartMs(event: CalendarEvent): number | null {
  const dt = event.start?.dateTime;
  if (typeof dt !== "string") return null;
  const ms = Date.parse(dt);
  return Number.isFinite(ms) ? ms : null;
}

export function armKey(event: CalendarEvent): string | null {
  const start = eventStartMs(event);
  if (start === null) return null;
  return `${event.id}|${new Date(start).toISOString()}`;
}

/** Dial-in passcode, if any. Only ever travels in the descriptor — never in a
 * log line or a receipt. */
export function passcodeFor(event: CalendarEvent, url: string): string | undefined {
  const fromEntry = event.conferenceData?.entryPoints?.find(
    (e) => typeof e.passcode === "string" && e.passcode.length > 0,
  )?.passcode;
  if (typeof fromEntry === "string" && fromEntry.length > 0) return fromEntry;
  try {
    const pwd = new URL(url).searchParams.get("pwd");
    return pwd && pwd.length > 0 ? pwd : undefined;
  } catch {
    return undefined;
  }
}

export function buildDescriptor(event: CalendarEvent, url: string, platform: ScribeDescriptor["platform"]): ScribeDescriptor {
  const passcode = passcodeFor(event, url);
  return {
    instance_id: event.id,
    platform,
    meeting_url: url,
    ...(passcode ? { passcode } : {}),
    title: event.summary,
    scheduled_start: event.start?.dateTime,
    scheduled_end: event.end?.dateTime,
    organizer_email: event.organizer?.email,
    invited_by: event.creator?.email,
    invitees: (event.attendees ?? []).map((a) => a.email).filter((e): e is string => typeof e === "string"),
    calendar_event_id: event.recurringEventId,
  };
}

/** The fields reconcile/notify need from a meeting. CalendarEvent satisfies
 * this; manual join requests synthesize it (no schedule required). */
export interface ReconcilableMeeting {
  id: string;
  summary?: string;
  end?: CalendarEventTime;
  organizer?: { email?: string };
  creator?: { email?: string };
}

/** Degraded-integration tracker: warn once while a dependency is missing,
 * log when it recovers. Keeps log noise down without hiding state — an
 * empty result and a failed integration stay distinguishable by the warn /
 * recover lines around them. Pure state machine over two log sinks. */
export function createDegradedTracker(options: {
  warn: (message: string) => void;
  info: (message: string) => void;
}): {
  degraded: (message: string) => void;
  recovered: (message: string) => void;
} {
  let degraded = false;
  return {
    degraded: (message: string) => {
      if (!degraded) {
        degraded = true;
        options.warn(message);
      }
    },
    recovered: (message: string) => {
      if (degraded) {
        degraded = false;
        options.info(message);
      }
    },
  };
}

/** A normalized "join this meeting" intent from any producer — the calendar
 * poll today, manual join requests next. dueAtMs/lateAtMs carry the source's
 * timing so tick() runs one arm-if-due rule for every request, regardless of
 * where it came from. */
export interface JoinRequest {
  /** The exact worker payload. Built once by the producer. */
  descriptor: ScribeDescriptor;
  /** Arm when now >= dueAtMs. Calendar: start − armLeadMs. */
  dueAtMs: number;
  /** Past this with no arm receipt, the request is terminally unreachable.
   *  Calendar: start + lateMaxMs. */
  lateAtMs: number;
  /** Calendar today; "manual" arrives with the manual producer. */
  source: "calendar" | "manual";
  /** Idempotency namespace. Calendar: event.id|event_start. */
  receiptKey: string;
  /** Source fields for reconcile/notify. */
  event: ReconcilableMeeting;
}

function isSelfOrganized(event: CalendarEvent, selfAddress: string | undefined): boolean {
  const self = selfAddress?.trim().toLowerCase();
  if (!self) return false;
  return event.organizer?.email?.trim().toLowerCase() === self;
}

/** Calendar producer: a poll event becomes a JoinRequest, or null for the
 * same quiet skips tick() always applied (cancelled, relay@'s own, all-day,
 * no link, non-provider host). */
export function joinRequestFromEvent(
  event: CalendarEvent,
  options: { armLeadMs: number; lateMaxMs: number; selfAddress?: string },
  log?: (message: string) => void,
): JoinRequest | null {
  if (event.status === "cancelled") return null;
  if (isSelfOrganized(event, options.selfAddress)) return null;
  const start = eventStartMs(event);
  if (start === null) return null; // all-day or unparseable
  const url = meetingUrlFor(event);
  if (!url) return null;
  const platform = platformForUrl(url);
  if (!platform) {
    log?.(`scribe: skipping ${event.id}: meeting host is not a provider domain`);
    return null;
  }
  const receiptKey = armKey(event);
  if (receiptKey === null) return null; // unreachable: start parsed above
  return {
    descriptor: buildDescriptor(event, url, platform),
    dueAtMs: start - options.armLeadMs,
    lateAtMs: start + options.lateMaxMs,
    source: "calendar",
    receiptKey,
    event,
  };
}

export class ScribeMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Last time a signed-out admin alert was emitted (rate limit). In-memory: a
   *  restart resets it, which is acceptable for an operator alert. */
  private lastSignedOutAlertMs = Number.NEGATIVE_INFINITY;
  /** Last worker generation seen on /status. In-memory: a harness restart
   * resets the baseline, and armed intents then reconcile through the normal
   * grace path (no worse than before boot tracking existed). */
  private lastWorkerBootId: string | null = null;
  private readonly deps: ScribeMonitorDeps;
  private readonly config: ScribeMonitorConfig;

  // Explicit fields, not constructor parameter properties: the harness runs
  // under Node's strip-only TypeScript mode, which rejects parameter properties.
  constructor(deps: ScribeMonitorDeps, config: ScribeMonitorConfig = scribeMonitorConfig()) {
    this.deps = deps;
    this.config = config;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /** One poll. Exposed for tests. */
  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const timeMin = new Date(now - this.config.windowBackMs).toISOString();
      const timeMax = new Date(now + this.config.windowForwardMs).toISOString();
      const events = await this.deps.listEvents(timeMin, timeMax);
      const manual = this.deps.listManualRequests ? await this.deps.listManualRequests() : [];
      const requests: JoinRequest[] = [];
      for (const event of events) {
        // Quiet skips live in the producer: cancelled, relay@'s own meetings,
        // all-day, no link, or a host that is not a provider. None of these
        // produce a notice.
        const request = joinRequestFromEvent(event, {
          armLeadMs: this.config.armLeadMs,
          lateMaxMs: this.config.lateMaxMs,
          selfAddress: this.deps.selfAddress,
        }, (message) => this.log(message));
        if (request) requests.push(request);
      }
      // Manual intents arrive already due (dueAtMs = acceptance time) and
      // carry their own receipt namespace, so they flow through the same
      // single arm-if-due rule below.
      requests.push(...manual);
      for (const request of requests) {
        // One poison request must never stall the tick: a throwing notify
        // (or status client) otherwise aborts calendar arming and every
        // later manual behind it, wedging the whole monitor on one intent.
        try {
          await this.processRequest(request, now);
        } catch (error) {
          this.log(`scribe: request ${request.descriptor.instance_id} failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    } catch (error) {
      this.log(`scribe: poll failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The single arming rule for every request, whatever produced it: past due
   * with no arm receipt, arm now; already handed to the worker (or terminally
   * unreachable), reconcile a notice from the worker's /status instead. */
  private async processRequest(request: JoinRequest, now: number): Promise<void> {
    if (this.deps.receipts.has("scribe.arm", request.receiptKey)) {
      await this.reconcile(request, now);
      return;
    }

    if (now < request.dueAtMs) return; // not yet

    if (now <= request.lateAtMs) {
      await this.armRequest(request, now);
    } else {
      // Join window closed with no arm receipt: the capture service never
      // accepted this meeting. Terminal + notify once, so the loop stops.
      // The arm receipt marks it handled so the next tick reconciles (and
      // short-circuits on the notify receipt) instead of re-notifying.
      this.deps.receipts.record("scribe.arm", request.receiptKey, "unreachable", now);
      this.log(`scribe: capture service unreachable for ${request.descriptor.instance_id}; window closed`);
      await this.finish(request, "unreachable", {
        kind: "unreachable",
        reason: "capture service unreachable",
        signedOut: false,
      }, now);
    }
  }

  /** Hand a due meeting to the worker. A crash between the POST and the receipt
   *  write just re-posts onto the idempotent /join next tick. */
  private async armRequest(request: JoinRequest, now: number): Promise<void> {
    const descriptor = request.descriptor;
    let result: { status: string };
    try {
      result = await this.deps.joinWorker(descriptor);
    } catch (error) {
      // Worker unreachable: no receipt, so the next tick retries.
      this.log(`scribe: worker join failed for ${descriptor.instance_id}: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    // A worker refusal (e.g. "at capacity" -> status failed) is terminal:
    // record the receipt so it is not retried, and let reconciliation send the
    // failure notice.
    if (result.status === "duplicate") {
      // The room is already live under another instance (calendar/manual
      // collision or same-room race): retire silently. The live capture's
      // own notice covers the user — a failure email here would be wrong,
      // nothing failed.
      this.deps.receipts.record("scribe.arm", request.receiptKey, "duplicate", now);
      await this.finish(request, "duplicate-room", null, now);
      this.log(`scribe: ${descriptor.instance_id} already captured; retiring duplicate request`);
      return;
    }
    this.deps.receipts.record("scribe.arm", request.receiptKey, result.status ?? "armed", now);
    if (request.source === "manual") this.deps.noteManualArmed?.(descriptor.instance_id);
    this.log(`scribe: armed ${descriptor.instance_id} (${descriptor.platform}) -> ${result.status ?? "armed"}`);
  }

  /** A meeting already handed to the worker: turn the terminal /status into one
   *  notice. Non-terminal states are re-checked next tick, with an exit after
   *  the grace window so a meeting the worker never recorded stops polling. */
  private async reconcile(request: JoinRequest, now: number): Promise<void> {
    const event = request.event;
    if (this.deps.receipts.has("scribe.notify", event.id)) return;
    let status: ScribeWorkerStatus;
    try {
      status = await this.deps.status(event.id);
    } catch (error) {
      // Transient: no receipt, retried next tick.
      this.log(`scribe: worker status failed for ${event.id}: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    // Worker restart detection: a changed boot id proves the worker's
    // in-memory sessions were wiped (an unknown session after a restart is
    // NOT the same as a never-existing one). Fail fast with a clear reason
    // instead of waiting out the grace window — and never blindly re-arm: a
    // second browser rejoining a live meeting is a visible duplicate the
    // user did not ask for. To resume capture the user re-requests, which
    // mints a fresh intent. First sighting only sets the baseline.
    if (typeof status.worker_boot_id === "string" && status.worker_boot_id !== "") {
      if (this.lastWorkerBootId !== null && status.worker_boot_id !== this.lastWorkerBootId) {
        this.lastWorkerBootId = status.worker_boot_id;
        await this.finish(request, "worker_restarted", {
          kind: "failed",
          reason: "capture worker restarted; the recording session did not survive",
          signedOut: false,
        }, now);
        return;
      }
      this.lastWorkerBootId = status.worker_boot_id;
    }
    if (!(TERMINAL_SCRIBE_STATES as readonly string[]).includes(status.status)) {
      // Manual captures carry a synthesized end (acceptance + grace), not a
      // real schedule: expiring them by wall clock would kill long meetings
      // mid-recording. Expire a manual capture only when the worker has no
      // record of it; while the worker reports it live, the worker owns the
      // lifecycle (its maxMeetingMs bounds it). Calendar captures keep the
      // scheduled-end grace, which is real data.
      const unknownToWorker = status.status === "unknown";
      if (request.source === "manual" && !unknownToWorker) return;
      const endMs = eventEndMs(event);
      if (endMs !== null && now > endMs + this.config.reconcileGraceMs) {
        await this.finish(request, "expired", null, now);
        this.log(`scribe: no worker record for ${event.id} after the grace window; giving up`);
      }
      return;
    }
    if (status.status === "skipped") {
      await this.finish(request, "skipped", null, now);
      this.log(`scribe: ${event.id} skipped by the worker; no notice`);
      return;
    }
    const signedOut = status.status === "failed" && isSignedOutReason(status.error);
    // Rate-limit the signed-out ADMIN alert; the organizer's plain failure notice
    // still sends. When suppressed, signedOut=false so only the organizer hears.
    const alertAdmins = signedOut && now - this.lastSignedOutAlertMs >= this.config.adminAlertIntervalMs;
    if (alertAdmins) this.lastSignedOutAlertMs = now;
    else if (signedOut) this.log(`scribe: signed-out admin alert for ${event.id} suppressed (rate limit)`);
    await this.finish(request, status.status, {
      kind: status.status === "failed" ? "failed" : "completed",
      reason: status.error,
      signedOut: alertAdmins,
      segment_count: status.segment_count,
    }, now);
  }

  /** Terminal close-out, exactly once per request (the notify receipt above
   *  short-circuits repeats): optionally email, then record the notice, then
   *  retire manual intents so the same room may be captured again. A failed
   *  email send throws BEFORE the receipt is recorded, so the next tick
   *  retries: notices are at-least-once, never silently dropped. */
  private async finish(
    request: JoinRequest,
    result: string,
    notice: { kind: ScribeNotice["kind"]; reason?: string; signedOut: boolean; segment_count?: number } | null,
    now: number,
  ): Promise<void> {
    if (notice) await this.emit(request.event, notice);
    this.recordNotify(request.event, result, now);
    if (request.source === "manual") this.deps.noteManualTerminal?.(request.descriptor.instance_id);
  }

  private recordNotify(event: ReconcilableMeeting, result: string, now: number): void {
    this.deps.receipts.record("scribe.notify", event.id, result, now);
  }

  private async emit(
    event: ReconcilableMeeting,
    notice: { kind: ScribeNotice["kind"]; reason?: string; signedOut: boolean; segment_count?: number },
  ): Promise<void> {
    const full: ScribeNotice = {
      instance_id: event.id,
      title: event.summary,
      organizer_email: event.organizer?.email,
      creator_email: event.creator?.email,
      scheduled_end: event.end?.dateTime,
      ...notice,
    };
    try {
      await this.deps.notify?.(full);
    } catch (error) {
      // Propagate: finish() must not record the notify receipt for an
      // undelivered notice, or the retry below could never happen.
      this.log(`scribe: notify failed for ${event.id}: ${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
  }
}
