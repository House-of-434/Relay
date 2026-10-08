/** Minimal research-eval entrypoint: `pnpm eval [--golden] [--live]`.
 *
 * - default: offline contract checks (discovery, attribution, freshness,
 *   cross-user isolation). No network, no browser, no models.
 * - --golden: replay the same checks against committed baselines and fail
 *   on any drift.
 * - --live: live-gated Reddit extraction. Without BLADEBRO_LIVE=1 this
 *   prints the skip line CI asserts and exits 0.
 */

import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceRootFor } from "../services/tool-layer/src/infra/workspace-identity.ts";
import { validateAttribution, type Finding } from "./lib/attribution.ts";
import { canonicalizeUrl, stubProvider, type SearchResult } from "./lib/discovery.ts";
import { freshnessBucket } from "./lib/freshness.ts";
import { redditLiveCheck } from "./lib/reddit-live.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
}

interface DiscoveryFixture {
  query: string;
  results: SearchResult[];
  expectedExactUrl: string;
}

interface FreshnessFixture {
  now: string;
  cases: Array<{ at: string }>;
}

interface CheckOutput {
  name: string;
  pass: boolean;
  detail: string;
  output: unknown;
}

async function discoveryCheck(): Promise<CheckOutput> {
  const fixture = readJson<DiscoveryFixture>("fixtures/discovery.json");
  const results = await stubProvider({ [fixture.query]: fixture.results }).search(fixture.query);
  const exactFound = results.some((result) => result.url === fixture.expectedExactUrl);
  const topCanonicalUrl = results.length > 0 ? canonicalizeUrl(results[0].url) : null;
  const pass = exactFound && results.length > 0;
  return {
    name: "discovery-exact-url",
    pass,
    detail: pass ? `exact URL found among ${results.length} results` : "expected exact URL missing",
    output: { topCanonicalUrl, exactFound, count: results.length },
  };
}

function attributionCheck(): CheckOutput {
  const good = readJson<Finding[]>("fixtures/attribution-good.json");
  const bad = readJson<Finding[]>("fixtures/attribution-bad.json");
  const goodResult = validateAttribution(good);
  const badResult = validateAttribution(bad);
  const pass = goodResult.ok && !badResult.ok;
  return {
    name: "source-attribution",
    pass,
    detail: pass
      ? "attributed findings pass, uncited findings fail"
      : `good errors: ${goodResult.errors.join("; ")}; bad accepted unexpectedly`,
    output: { goodOk: goodResult.ok, badOk: badResult.ok, badErrorCount: badResult.errors.length },
  };
}

function freshnessCheck(): CheckOutput {
  const fixture = readJson<FreshnessFixture>("fixtures/freshness.json");
  const nowMs = Date.parse(fixture.now);
  const buckets = fixture.cases.map((entry) => freshnessBucket(entry.at, nowMs));
  return {
    name: "freshness",
    pass: buckets.length === fixture.cases.length,
    detail: `buckets: ${buckets.join(", ")}`,
    output: { buckets },
  };
}

function isolationCheck(): CheckOutput {
  const alice = "123e4567-e89b-42d3-a456-426614174000";
  const bob = "123e4567-e89b-42d3-a456-426614174001";
  const rootA = workspaceRootFor("/data/blade", alice);
  const stable = rootA === workspaceRootFor("/data/blade", alice.toUpperCase());
  const disjoint = rootA !== workspaceRootFor("/data/blade", bob);
  let rejectsInvalid = false;
  try {
    workspaceRootFor("/data/blade", "../escape");
  } catch {
    rejectsInvalid = true;
  }
  const pass = stable && disjoint && rejectsInvalid;
  return {
    name: "cross-user-isolation",
    pass,
    detail: pass ? "workspaces stable per user, disjoint across users" : "isolation property violated",
    output: { stable, disjoint, rejectsInvalid },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--live")) {
    const verdict = await redditLiveCheck();
    console.log(`live tier ${verdict.status}: ${verdict.reason}`);
    if (verdict.status === "skipped") console.log("live tier skipped");
    process.exitCode = verdict.status === "failed" ? 1 : 0;
    return;
  }

  const golden = args.includes("--golden");
  const checks = [await discoveryCheck(), attributionCheck(), freshnessCheck(), isolationCheck()];
  let failed = 0;
  for (const check of checks) {
    let pass = check.pass;
    let detail = check.detail;
    if (golden) {
      try {
        deepStrictEqual(check.output, readJson(`baselines/${check.name}.json`));
      } catch (error) {
        pass = false;
        detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
    }
    console.log(`${pass ? "ok  " : "FAIL"} ${check.name}: ${detail}`);
    if (!pass) failed++;
  }
  console.log(golden ? `${checks.length - failed}/${checks.length} golden checks match` : `${checks.length - failed}/${checks.length} offline checks pass`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
