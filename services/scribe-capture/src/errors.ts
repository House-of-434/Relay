/** Turn a join failure into the reason written on the meeting row.
 *
 * The signed-out case gets a specific, actionable reason: relay@'s browser
 * session will eventually expire or be challenged, and "every Meet failing for
 * no visible reason" is the failure this names. The vendored join throws
 * `AuthSessionError` for it; we match by name and by message so a rename does
 * not silently regress. */
export function describeJoinFailure(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  const message = error instanceof Error ? error.message : "capture failed";
  if (name === "AuthSessionError" || /signed[\s-]?out/i.test(message) || /re-?authenticate/i.test(message)) {
    return "relay@ browser profile is signed out — re-authenticate the Scribe profile";
  }
  return message.slice(0, 300);
}
