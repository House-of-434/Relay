# vexa-capture

Vendored capture/join/transcription sources from
[Vexa](https://github.com/Vexa-ai/vexa) (`UPSTREAM_COMMIT` pins the exact
revision; v0.12.28). **Do not edit these files.** Adapt them in
`services/scribe-capture` and record each adaptation below.

## License

Apache License 2.0 — see `LICENSE`. This directory satisfies the license's
redistribution terms: the license copy, this provenance notice, and (for any
file Relay modifies in the future) a record of the change. Vexa source files
carry no per-file headers; the license lives at the repository root there as
it does here.

Third-party artifacts these sources depend on (not vendored here):
- `playwright@1.56.0` (Apache-2.0), `playwright-extra@4.3.6` (MIT),
  `puppeteer-extra-plugin-stealth@2.11.2` (MIT)
- `@huggingface/transformers@4.2.0` (Apache-2.0),
  `onnxruntime-node@1.17.0` (MIT)
- `onnx-community/pyannote-segmentation-3.0` weights (MIT conversion; notice
  governed by pyannote.audio)

## What was taken and why

| Path | Purpose |
|---|---|
| `core/meetings/modules/mixed-capture-core/` | WebRTC remote-audio hook, Teams main-audio tap, CSRC transport poll |
| `core/meetings/modules/mixed-pipeline/` | Mixed-lane (Zoom/Teams) chunked transcription + hints-based speaker binder |
| `core/meetings/modules/gmeet-pipeline/` | Per-channel Meet lane (named audio, no diarizer) |
| `core/meetings/modules/gmeet-capture/` | **Meet page-side capture** (browser): per-participant PCM (`gmeet-capture`, AudioWorklet `pcm-capture`) + glow speaker naming (`gmeet-speakers`, `gmeet-channel-binder`) + the `capture.v1` producer (`gmeet-capture-v1`) |
| `core/meetings/modules/buffer/` | `@vexa/transcribe-buffer`: LocalAgreement-N confirm core + `GmeetCompatibleBuffer` (the pipeline's confirmation primitive) |
| `core/meetings/modules/whisper/` | `stt.v1` multipart-WAV client contract + confidence filter |
| `core/meetings/contracts/transcript.v1/` | The SEALED `transcript.v1` schema (+ golden) the pipeline conformance golden validates against |
| `core/meetings/modules/zoom-capture/` | **Zoom per-track lane** (browser): `zoom-speakers` (active-speaker DOM watcher), `zoom-chat` (chat panel reader), and `track-name-resolver` (the pure vote/margin/purity/1:1/self correlator that binds each stable WebRTC track to a display name) |
| `core/meetings/modules/join/` | Deterministic Meet/Zoom/Teams selectors (`googlemeet`, `zoom`, `msteams`, `shared`, root `_host`/`browser-args`/`index`) — plus the `jitsi` lane, included although Scribe never instantiates it, because `index.ts` imports it and the package must stay coherent |
| `core/meetings/services/bot/src/{capture-bridge,pipeline,join-driver}.ts` | Orchestration seam — **adapt, don't copy wholesale** |

Test files shipped alongside the sources above (`*.test.ts`, `contracts/`,
`hallucinations/`) so the golden/contract net travels with the code:
`confirm-loop.golden`, `pending-stability`, `webrtc-dedup`, `gap-reclaim`,
`never-lose-tail`, plus lane conformance and parity tests.

## What was NOT taken

Vexa's gateway, agent platform, dashboards, share links, recordings, TTS,
routines, workspaces, webhooks, API-key machinery, and the `jitsi` lane.
Those stay upstream reference material only.

## Verification

Vendored sources are byte-identical to the pinned upstream commit; per-file
SHA-256 hashes are in `HASHES`. Re-verify with
`git show <UPSTREAM_COMMIT>:<upstream path>` per the mapping above.

**Layout.** Most modules are flattened: their upstream `src/` contents live
directly under the module directory here (e.g.
`mixed-pipeline/chunked-transcriber.ts`, not
`mixed-pipeline/src/chunked-transcriber.ts`); their vendored `README.md` is the
upstream `src/README.md`. Two modules keep their `src/` level because code in
them resolves files by relative path above `src/`:
- `join/` — only four subdirectories were taken.
- `zoom-capture/` — `package.json` and `tsconfig.json` sit above `src/`
  upstream; taken as-is so the module keeps its own entry point and the
  vendored tests run from their original relative paths.
- `gmeet-pipeline/` — `pipeline-conformance.test.ts` reads the sealed schema at
  `../../../contracts/transcript.v1/transcript.schema.json`, which only resolves
  from `gmeet-pipeline/src/`. `contracts/transcript.v1/` is vendored at its
  upstream-relative location for the same reason.

Relative imports within a module are unaffected by flattening. The vendored
golden tests are run UNMODIFIED by
`pnpm --filter @relay/scribe-capture test:vendored`.

## Adaptations

Only the documented changes below deviate from upstream. No vendored source
(`*.ts`) was edited except the documented `zoom-capture` chat removal.

- `package.json` (added for `gmeet-capture`, `gmeet-pipeline`, `buffer`,
  `whisper`) — 2026-10-10 — Upstream ships no in-tree package manifest for these
  (its packages are build outputs). Added so the vendored modules resolve as
  pnpm workspace packages: `exports` points at the flattened `index.ts`, and
  `gmeet-pipeline` declares its `@vexa/transcribe-buffer` /
  `@vexa/transcribe-whisper` siblings so their bare specifiers resolve without
  editing the vendored import lines. `gmeet-capture`'s type-only
  `@vexa/capture-codec` dependency is not vendored (it is erased at build; the
  value it backs, `createGmeetCaptureV1`, is not on Scribe's path).
- `gmeet-pipeline/*` — 2026-10-10 — Re-laid out to keep the upstream `src/`
  level (see Layout) so the conformance golden runs unmodified.
- `zoom-capture/package.json` — 2026-10-24 — Added for `@vexa/zoom-capture`,
  same reason and shape as the other vendored manifests: upstream builds
  `dist/`, while our capture entry is bundled by esbuild straight from source,
  so `exports`/`main`/`types` point at `./src/index.ts`. The upstream `scripts`
  and `devDependencies` are kept verbatim; only `exports`, `main`, `types`, the
  `private` flag and the description are Relay's.
- `zoom-capture/src/zoom-chat.ts` — 2026-10-24 — Removed from the vendored set
  (plus its `createZoomChat` export and chat cases in `zoom-capture.test.ts`);
  the resolver and speaker modules stay byte-identical. Our capture path does
  not ingest chat yet, and the upstream chat dedup was flagged lossy (repeat
  messages sharing sender+text collapse), so dead flagged code is diverged out
  rather than shipped.
