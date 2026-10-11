#!/usr/bin/env node
/**
 * Bundle the Meet per-channel capture glue → dist/gmeet-capture.bundle.js.
 *
 * Mirrors upstream Vexa's build-browser-utils.mjs (esbuild, browser IIFE) but only
 * imports @vexa/gmeet-capture — the page-side entry is our own glue
 * (src/capture-gmeet.entry.ts), which composes the vendored bricks. The vendored
 * TypeScript sources are bundled as-is (esbuild resolves their `./x.js` specifiers to
 * the `.ts` files; `import type` of @vexa/capture-codec is erased).
 *
 * The worker injects the output with Playwright addInitScript, alongside the
 * remote-audio hook (src/vexa-remote-audio-hook.ts).
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "../dist/gmeet-capture.bundle.js");

await build({
  entryPoints: [resolve(here, "../src/capture-gmeet.entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outfile,
  legalComments: "none",
  logLevel: "info",
});

console.log(`built ${outfile} (${statSync(outfile).size} bytes)`);
