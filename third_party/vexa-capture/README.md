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
| `core/meetings/modules/whisper/` | `stt.v1` multipart-WAV client contract + confidence filter |
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

These files are byte-identical to the pinned upstream commit (121 `.ts` /
`package.json` files plus `LICENSE`, verified 2026-10-10). Layout note: each
module's `src/` contents live directly under the module directory here
(e.g. `mixed-pipeline/chunked-transcriber.ts`, not
`mixed-pipeline/src/chunked-transcriber.ts`); the `join` lane keeps its
`src/` level because only four of its subdirectories were taken. Relative
imports are unaffected either way. Per-file SHA-256 hashes: `HASHES`.
Re-verify with `git show <UPSTREAM_COMMIT>:<upstream path>` per the mapping
above, or `diff -r` against a fresh checkout with the `src/` level accounted
for.

## Adaptations

None yet. Record each future adaptation here as:
`<file> — <date> — <what changed and why>`.
