/** Durable, non-actionable projection of one background routine run.
 *
 * The provider still runs in its isolated execution task. This small card is
 * upserted into the trusted conversation that created the routine so the user
 * can see progress, results, and where to review an approval without hunting
 * through the routines calendar.
 */
export interface RoutineRunCardData {
  runId: string;
  routineId: string;
  routineName: string;
  scheduledFor?: number;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "missed";
  /** Which dispatcher owns the run. "research" is legacy only: older builds
   * wrote one-shot deep-research executions here, and old cards still read as
   * research, not as a routine run. Nothing authors it now — confirming a
   * research plan opens a dedicated thread, never a run. Absent means a
   * routine or legacy run. */
  triggerSource?: "schedule" | "manual" | "webhook" | "research";
  /** Present while a queued run is being held because its target bot or room
   * is busy. The status stays queued; this is the surfaced deferral fact. */
  deferredAt?: number;
  /** Exact terminal team-goal outcome when this run targeted a room. */
  goalStatus?: "completed" | "needs-input" | "blocked" | "limit-reached" | "paused" | "stopped" | "failed";
  executionThreadId?: string;
  summary?: string;
  error?: string;
}
