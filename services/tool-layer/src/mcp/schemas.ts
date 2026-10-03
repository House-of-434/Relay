import { z } from "zod";

export const READ_INPUT = {
  table: z.string().min(1),
  filters: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const WRITE_INPUT = {
  table: z.string().min(1),
  operation: z.enum(["insert", "update"]),
  data: z.record(z.unknown()),
  where: z.record(z.unknown()).optional(),
};

export const EVENT_TIME_INPUT = z.union([
  z.object({ dateTime: z.string().min(1).max(64), timeZone: z.string().min(1).max(64).optional() }),
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

/**
 * One guest, described as an edit rather than a replacement list. The connector
 * merges these into the existing attendees, so naming a guest changes only that
 * guest and a guest left unnamed keeps its seat.
 */
export const ATTENDEE_INPUT = z.object({
  email: z.string().min(3).max(320),
  responseStatus: z.enum(["accepted", "tentative", "declined"]).optional(),
  comment: z.string().max(8_000).optional(),
}).strict();

export const EVENT_DRAFT_INPUT = {
  summary: z.string().min(1).max(500),
  start: EVENT_TIME_INPUT,
  end: EVENT_TIME_INPUT,
  description: z.string().max(8_000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string().min(3).max(320)).max(50).optional(),
  timeZone: z.string().min(1).max(64).optional(),
};

/**
 * Update is patch-shaped. "Move it to 3pm" should carry a new time, not a
 * reconstruction of every field the caller happened to read.
 */
export const EVENT_CHANGES_INPUT = {
  summary: z.string().min(1).max(500).optional(),
  start: EVENT_TIME_INPUT.optional(),
  end: EVENT_TIME_INPUT.optional(),
  description: z.string().max(8_000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(ATTENDEE_INPUT).max(50).optional(),
  timeZone: z.string().min(1).max(64).optional(),
};

/**
 * Notification intent, deliberately not Google's vocabulary: the model says
 * whether the user wanted guests told, and the connector decides the parameter.
 * Left out means notify whenever guests are affected.
 */
export const NOTIFY_INPUT = z.enum(["default", "yes", "no"]);
