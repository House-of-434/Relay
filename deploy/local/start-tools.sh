#!/bin/bash
# tools service: Tool Layer only. RELAY_TOOL_HOST must be 0.0.0.0 here
# (compose sets it) because the harness reaches this container over the
# compose network. The HMAC actor assertion stays the real boundary.
set -u
exec node /app/tool-layer-dist/index.js
