#!/bin/bash
# Scribe worker: the per-channel capture + ingest client. Runs from TypeScript
# via tsx because the vendored third_party capture bricks are .ts loaded lazily
# by relative specifier at runtime. tini (compose `init: true`) is PID 1; this
# script execs so the worker receives signals directly and a fatal exit
# (index.ts exits 1 on a listen/startup failure) trips `restart: unless-stopped`.
set -eu
exec /app/services/scribe-capture/node_modules/.bin/tsx \
  /app/services/scribe-capture/src/index.ts
