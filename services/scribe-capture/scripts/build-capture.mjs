#!/usr/bin/env node
/**
 * Bundle the page-side capture glue, one IIFE per platform:
 *   src/capture-gmeet.entry.ts → dist/gmeet-capture.bundle.js
 *   src/capture-zoom.entry.ts  → dist/zoom-capture.bundle.js
 *
 * One bundle per platform (never a shared entry) so a Zoom change cannot alter the
 * Meet bundle's bytes and vice versa.
 *
 * Mirrors upstream Vexa's build-browser-utils.mjs (esbuild, browser IIFE). Each
 * page-side entry is our own glue composing vendored bricks (@vexa/gmeet-capture,
 * @vexa/zoom-capture). The vendored TypeScript sources are bundled as-is (esbuild
 * resolves their `./x.js` specifiers to the `.ts` files; `import type` of
 * @vexa/capture-codec is erased).
 *
 * The worker injects the output with Playwright addInitScript, alongside the
 * remote-audio hook (src/vexa-remote-audio-hook.ts).
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

const ENTRIES = [
  ["../src/capture-gmeet.entry.ts", "../dist/gmeet-capture.bundle.js"],
  ["../src/capture-zoom.entry.ts", "../dist/zoom-capture.bundle.js"],
];

for (const [entry, out] of ENTRIES) {
  const outfile = resolve(here, out);
  await build({
    entryPoints: [resolve(here, entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    outfile,
    legalComments: "none",
    logLevel: "info",
  });
  console.log(`built ${outfile} (${statSync(outfile).size} bytes)`);
}
