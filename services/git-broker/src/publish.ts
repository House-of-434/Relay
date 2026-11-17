import type { PublishAttachment } from "./authorization.ts";

export function pullBody(body: string, attachments: PublishAttachment[], urls: string[]): string {
  if (!urls.length) return body.trim();
  const visual = attachments.map((attachment, index) => attachment.mime.startsWith("image/")
    ? `![${attachment.name}](${urls[index]})`
    : `[${attachment.name}](${urls[index]})`);
  return `${body.trim()}\n\n## Visual review\n\n${visual.join("\n\n")}\n`;
}
