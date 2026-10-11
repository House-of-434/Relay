#!/bin/bash
# Scribe worker: the per-channel capture + ingest client. Runs from TypeScript
# via tsx because the vendored third_party capture bricks are .ts loaded lazily
# by relative specifier at runtime.
#
# HEADFUL under Xvfb: Zoom detects a headless browser and serves the "automated
# bots aren't allowed / must use Zoom RTMS" wall even with a signed-in profile,
# so the browser must render to a virtual display. Meet works headless but is
# unaffected by running headful, so the worker always runs headful here.
#
# tini (compose `init: true`) is PID 1; this script execs so the worker receives
# signals directly and a fatal exit (index.ts exits 1 on listen/startup failure)
# trips `restart: unless-stopped`.
set -eu
export DISPLAY="${DISPLAY:-:99}"
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp &
  for _ in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.2; done
fi
export RELAY_SCRIBE_HEADLESS="${RELAY_SCRIBE_HEADLESS:-0}"
exec /app/services/scribe-capture/node_modules/.bin/tsx \
  /app/services/scribe-capture/src/index.ts
