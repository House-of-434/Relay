import { describe, expect, it } from "vitest";

import { workspaceRootFor } from "../services/tool-layer/src/infra/workspace-identity.ts";
import { validateAttribution } from "./lib/attribution.ts";
import { canonicalizeUrl, stubProvider } from "./lib/discovery.ts";
import { freshnessBucket } from "./lib/freshness.ts";
import { loadRedditFixture } from "./lib/reddit-live.ts";

const ALICE = "123e4567-e89b-42d3-a456-426614174000";
const BOB = "123e4567-e89b-42d3-a456-426614174001";

describe("offline research contract", () => {
  it("finds the exact expected URL and canonicalizes discovery output", async () => {
    const results = await stubProvider({
      "top askreddit today": [
        { url: "https://www.reddit.com/r/AskReddit/top/?t=day&utm_source=share", title: "AskReddit top", snippet: "top posts" },
      ],
    }).search("top askreddit today");
    expect(results.map((result) => result.url)).toContain("https://www.reddit.com/r/AskReddit/top/?t=day&utm_source=share");
    expect(canonicalizeUrl(results[0].url)).toBe("https://www.reddit.com/r/AskReddit/top/?t=day");
    expect(canonicalizeUrl("https://WWW.Example.COM/")).toBe("https://www.example.com");
    expect(() => canonicalizeUrl("not a url")).toThrow();
  });

  it("accepts attributed findings and rejects uncited ones", () => {
    expect(
      validateAttribution([{ claim: "seeded", source_url: "https://example.com/a", confidence: 0.9 }]).ok,
    ).toBe(true);
    const bad = validateAttribution([
      { claim: "no source", confidence: 0.5 },
      { claim: "bad confidence", source_url: "https://example.com/b", confidence: 1.5 },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(2);
  });

  it("buckets freshness from observed_at", () => {
    const now = Date.parse("2026-10-04T00:00:00.000Z");
    expect(freshnessBucket("2026-10-03T00:00:00.000Z", now)).toBe("fresh");
    expect(freshnessBucket("2026-09-20T00:00:00.000Z", now)).toBe("aging");
    expect(freshnessBucket("2026-01-01T00:00:00.000Z", now)).toBe("stale");
    expect(() => freshnessBucket("yesterday", now)).toThrow();
  });

  it("isolates workspaces by user", () => {
    expect(workspaceRootFor("/data/blade", ALICE)).toBe(workspaceRootFor("/data/blade", ALICE));
    expect(workspaceRootFor("/data/blade", ALICE)).not.toBe(workspaceRootFor("/data/blade", BOB));
    expect(() => workspaceRootFor("/data/blade", "mallory")).toThrow();
  });

  it("keeps the reddit live fixture self-consistent", () => {
    const fixture = loadRedditFixture();
    expect(fixture.url).toMatch(/^https:\/\//);
    expect(fixture.expectedFields.length).toBeGreaterThan(0);
  });
});
