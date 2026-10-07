/** Deep-research request tag: the Composer toggle prefixes the outgoing
 * message with this, and Scout's soul recognizes a leading tag (or
 * explicit deep-investigation wording) as a deep-research request. The tag
 * travels as ordinary message text — no backend plumbing — so it survives
 * restarts and works across every engine. Only a leading tag counts, so
 * quoted or pasted occurrences mid-text cannot trigger it. */

export const DEEP_RESEARCH_TAG = "[deep research]";

export function withDeepResearchTag(body: string, deep: boolean): string {
  if (!deep || !body) return body;
  if (body.startsWith(DEEP_RESEARCH_TAG)) return body;
  return `${DEEP_RESEARCH_TAG} ${body}`;
}

export function isDeepResearchRequest(text: string): boolean {
  return text.startsWith(DEEP_RESEARCH_TAG);
}
