#!/bin/bash
# relay service: harness + BFF in one container. They must share localhost
# because the BFF hardcodes the harness at 127.0.0.1 (services/bff/server.ts).
# tini (compose `init: true`) stays PID 1; this script forwards signals.
set -u
node /app/dist-server/index.js &
HARNESS_PID=$!
node --experimental-strip-types /app/services/bff/server.ts &
BFF_PID=$!
trap 'kill $HARNESS_PID $BFF_PID 2>/dev/null' TERM INT
wait -n
kill $HARNESS_PID $BFF_PID 2>/dev/null
wait
