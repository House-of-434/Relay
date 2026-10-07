import { describe, expect, it } from "vitest";

import { DEEP_RESEARCH_TAG, isDeepResearchRequest, withDeepResearchTag } from "./deep-research";

describe("deep-research tag", () => {
  it("prefixes the body once when deep is on", () => {
    expect(withDeepResearchTag("research X", true)).toBe(`${DEEP_RESEARCH_TAG} research X`);
    expect(withDeepResearchTag(`${DEEP_RESEARCH_TAG} research X`, true)).toBe(`${DEEP_RESEARCH_TAG} research X`);
  });

  it("leaves the body untouched when deep is off or empty", () => {
    expect(withDeepResearchTag("research X", false)).toBe("research X");
    expect(withDeepResearchTag("", true)).toBe("");
  });

  it("recognizes only a leading tag", () => {
    expect(isDeepResearchRequest(`${DEEP_RESEARCH_TAG} research X`)).toBe(true);
    expect(isDeepResearchRequest("research X")).toBe(false);
    expect(isDeepResearchRequest(`someone wrote ${DEEP_RESEARCH_TAG} once`)).toBe(false);
  });
});
