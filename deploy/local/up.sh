#!/bin/bash
# Bring the local stack up, and never leave Caddy stranded.
#
# caddy runs with `network_mode: service:app`, so it lives inside the app
# container's network namespace. Recreating `app` on its own destroys that
# namespace; a still-running caddy then has no interface, no DNS (its ACME
# lookups fail with "127.0.0.11:53 connection refused") and no published ports,
# so the site is unreachable while every container reports "Up".
#
# The only safe deploy is a whole-project `compose up` (no service list), which
# recreates caddy alongside app. This script does that and then verifies the
# attachment, so the mistake is caught even if someone changes the command.
#
# Usage:
#   deploy/local/up.sh                # build, then up -d
#   deploy/local/up.sh --no-build     # up -d only (config/env changes)
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "${1:-}" != "--no-build" ]; then
  docker compose build
fi

# No service list on purpose: naming a subset that includes app but not caddy
# is exactly the bug this script exists to prevent.
docker compose up -d --remove-orphans

app_id="$(docker compose ps -q app)"
if [ -z "$app_id" ]; then
  echo "ERROR: app container is not running; cannot verify caddy attachment." >&2
  docker compose ps >&2
  exit 1
fi

caddy_id="$(docker compose ps -q caddy)"
if [ -z "$caddy_id" ]; then
  echo "ERROR: caddy container is not running." >&2
  docker compose ps >&2
  exit 1
fi

caddy_netns="$(docker inspect "$caddy_id" --format '{{.HostConfig.NetworkMode}}')"
if [ "$caddy_netns" != "container:$app_id" ]; then
  # Defensive: a stale caddy is invisible in `compose ps` and only shows up as
  # a dead site, so fix it here rather than reporting success.
  echo "WARNING: caddy is attached to ${caddy_netns}, not the running app container." >&2
  echo "         Recreating caddy so it rejoins app's network namespace..." >&2
  docker compose up -d --force-recreate caddy
  caddy_netns="$(docker inspect "$(docker compose ps -q caddy)" --format '{{.HostConfig.NetworkMode}}')"
  if [ "$caddy_netns" != "container:$app_id" ]; then
    echo "ERROR: caddy still not attached to app (${caddy_netns}); the site will be unreachable." >&2
    exit 1
  fi
fi

docker compose ps
echo "OK: caddy is attached to the running app container."
