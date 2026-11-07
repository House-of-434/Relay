#!/bin/bash
# tools service: Tool Layer only. RELAY_TOOL_HOST must be 0.0.0.0 here
# (compose sets it) because the harness reaches this container over the
# compose network. The HMAC actor assertion stays the real boundary.
set -u
# Headful login browser needs a virtual display: Xvfb on $DISPLAY (:99).
# Start it here so headful takeovers survive container restarts.
if command -v Xvfb >/dev/null 2>&1; then
  display="${DISPLAY:-:99}"
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    Xvfb "$display" -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 &
    sleep 1
  fi
fi
exec node /app/services/tool-layer/dist/index.js
