/** Shared types for the Scribe capture worker (slice 1: Meet). */

export type Platform = "google_meet" | "zoom" | "teams";

export type CaptureStatus =
  | "joining"
  | "awaiting_admission"
  | "active"
  | "completed"
  | "partial"
  | "failed"
  | "skipped";

/** The join descriptor the monitor sends (passcode is the only secret field). */
export interface JoinDescriptor {
  instance_id: string;
  platform: Platform;
  meeting_url: string;
  passcode?: string;
  title?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  organizer_email?: string;
  invited_by?: string;
  invitees?: string[];
  calendar_event_id?: string;
  /** Set when the monitor's own validation failed; the worker writes a failed
   * row without attempting a join (URL/host failure, at capacity). */
  reject_reason?: string;
}

/** One confirmed transcript segment. `segment_key` is stable per meeting. */
export interface Segment {
  segment_key: string;
  speaker: string | null;
  start_seconds: number;
  end_seconds: number;
  text: string;
  confidence?: number | null;
  language?: string | null;
}

/** Meeting row fields the worker controls. `actual_start` is capture time zero. */
export interface MeetingRow {
  platform: Platform;
  instance_id: string;
  calendar_event_id?: string | null;
  native_id?: string | null;
  title?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  status: CaptureStatus;
  error?: string | null;
  organizer_email?: string | null;
  invited_by?: string | null;
  invitees?: string[];
  segment_count?: number;
  duration_seconds?: number | null;
}

export interface JoinOutcome {
  instance_id: string;
  status: CaptureStatus | "unknown";
  /** Present once capture begins; this is time zero. */
  capture_started_at?: string;
  error?: string;
}

export interface StatusOutcome {
  instance_id: string;
  status: CaptureStatus | "unknown";
  segment_count: number;
  capture_started_at?: string;
  error?: string;
}

/** The orchestration surface the HTTP layer calls. Implemented by the real
 * session controller and by test fakes. */
export interface JoinController {
  /** Idempotent by instance_id: a second call returns the existing capture. */
  join(descriptor: JoinDescriptor): Promise<JoinOutcome>;
  status(instanceId: string): Promise<StatusOutcome>;
  stop(instanceId: string): Promise<JoinOutcome>;
}
