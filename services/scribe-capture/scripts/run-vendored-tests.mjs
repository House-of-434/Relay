#!/usr/bin/env node
/**
 * Run the vendored Vexa capture/buffer/whisper/pipeline golden tests UNMODIFIED.
 *
 * These are the upstream `*.test.ts` files shipped alongside the vendored sources
 * (see third_party/vexa-capture/README.md). They are run with tsx so the bare
 * `@vexa/*` specifiers inside them resolve via the workspace packages registered in
 * pnpm-workspace.yaml — no vendored import line is edited.
 *
 * The one excluded file is gmeet-pipeline/pipeline-realstt.live.test.ts: it needs a
 * live STT server, so it is not part of the offline gate.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const modules = resolve(here, "../../../third_party/vexa-capture/core/meetings/modules");

const tests = [
  "buffer/local-agreement.test.ts",
  "whisper/confidence.test.ts",
  "whisper/errors.test.ts",
  "whisper/model.test.ts",
  "gmeet-capture/gmeet-capture.test.ts",
  "gmeet-capture/gmeet-speakers.test.ts",
  "gmeet-capture/gmeet-channel-binder.test.ts",
  "gmeet-pipeline/src/hallucination-filter.test.ts",
  "gmeet-pipeline/src/silence-gate.test.ts",
  "gmeet-pipeline/src/harvest-hallucinations.test.ts",
  "gmeet-pipeline/src/pipeline-conformance.test.ts",
  "gmeet-pipeline/src/fault-surfacing.test.ts",
  "gmeet-pipeline/src/probe.test.ts",
  "gmeet-pipeline/src/confirm-loop.golden.test.ts",
  "gmeet-pipeline/src/count-channelswitch.test.ts",
  "gmeet-pipeline/src/gmeet-compatible-buffer.parity.test.ts",
];

let failed = 0;
for (const rel of tests) {
  const file = resolve(modules, rel);
  process.stdout.write(`\n=== ${rel} ===\n`);
  const r = spawnSync("npx", ["tsx", file], { stdio: "inherit", cwd: resolve(here, "..") });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`FAILED: ${rel}\n`);
  }
}

if (failed) {
  process.stderr.write(`\n${failed} vendored test file(s) FAILED.\n`);
  process.exit(1);
}
process.stdout.write(`\nAll ${tests.length} vendored test files passed.\n`);
