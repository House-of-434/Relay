import type { PublishAttachment } from "./authorization.ts";

/** GitHub's compare status is relative to the remote branch as base and the
 * local commit as head. Only a descendant may advance the branch without a
 * force push. */
export function fastForwardable(status: string): boolean {
  return status === "ahead" || status === "identical";
}

export function pullBody(body: string, attachments: PublishAttachment[], urls: string[]): string {
  if (!urls.length) return body.trim();
  const visual = attachments.map((attachment, index) => attachment.mime.startsWith("image/")
    ? `![${attachment.name}](${urls[index]})`
    : `[${attachment.name}](${urls[index]})`);
  return `${body.trim()}\n\n## Visual review\n\n${visual.join("\n\n")}\n`;
}
