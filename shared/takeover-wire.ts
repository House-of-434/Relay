/** Browser-takeover card creation wire contract.
 *
 * The Tool Layer builds this payload; the BFF terminates tool-facing auth and
 * forwards it; the harness validates it again before persisting the card. One
 * schema for both internal legs so the two cannot drift.
 */
import { z } from "zod";

export const browserTakeoverCardSchema = z.object({
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  expires_at: z.string().datetime(),
  /** One-shot PNG/JPEG data URL; absent when the capture failed. */
  screenshot: z.string().max(2_100_000).optional(),
}).strict();

export type BrowserTakeoverCard = z.infer<typeof browserTakeoverCardSchema>;
