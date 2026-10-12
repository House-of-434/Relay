# Relay cloud MVP image: harness + BFF + Tool Layer + Bladebro + Chrome.
#
# Single image, three processes across two compose services: `relay` runs the
# harness and the BFF (the BFF hardcodes the harness at 127.0.0.1, so they
# share a network namespace), `tools` runs the Tool Layer on its own
# container with RELAY_TOOL_HOST=0.0.0.0.
#
# Build from the repo root:
#   docker build -f deploy/local/Dockerfile -t relay-relay:local .
# Or via compose (context is the repo root, not deploy/local):
#   docker compose build && docker compose up -d
#
# MVP persistence is SQLite on the persistent /data volume. Migration to
# Supabase/Postgres is planned before treating this deployment as production
# durable storage.

FROM node:24-bookworm-slim AS build
WORKDIR /src
# pinned to package.json#packageManager; corepack is being removed from Node
RUN npm install -g pnpm@10.33.0
# The image never runs Electron, so skip its ~100MB postinstall download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# every workspace member's manifest must exist before install resolves the lockfile
COPY services/tool-layer/package.json ./services/tool-layer/package.json
COPY packages/relay-shared/package.json ./packages/relay-shared/package.json
# package.json's `prepare` runs during install. The script itself is written to
# no-op without a .git (it exits 0 here), but node still has to be able to LOAD
# it, and .dockerignore keeps .git out — so copy it in before install or the
# whole build dies on MODULE_NOT_FOUND.
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:server && pnpm exec vite build \
  && pnpm --filter @relay/tool-layer build

FROM node:24-bookworm-slim AS runtime
# Chrome + Xvfb (headful on a headless host) + the shared libraries the root
# Dockerfile already provisions. No version pin on Chrome: pinning stays
# deferred (plans/deferred.md) and apt takes the stable channel.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git wget gnupg \
     xvfb \
     libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
     libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
     libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
     libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
     libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
     libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
     libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /data --shell /bin/bash maus
WORKDIR /app
COPY --from=build --chown=maus:maus /src/dist-server ./dist-server
COPY --from=build --chown=maus:maus /src/dist ./dist
# The compiled Tool Layer must live inside its workspace package directory:
# pnpm isolates workspace deps under services/tool-layer/node_modules, so
# running the bundle from anywhere else breaks Node module resolution
# (ERR_MODULE_NOT_FOUND for @supabase/supabase-js et al).
COPY --from=build --chown=maus:maus /src/services/tool-layer/dist ./services/tool-layer/dist
# The BFF runs from source via Node type-stripping (it has no bundle step),
# so it ships with the shared tree it imports and production node_modules.
COPY --from=build --chown=maus:maus /src/services/bff ./services/bff
COPY --from=build --chown=maus:maus /src/shared ./shared
COPY --from=build --chown=maus:maus /src/packages ./packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/tool-layer/package.json ./services/tool-layer/package.json
COPY packages/relay-shared/package.json ./packages/relay-shared/package.json
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN npm install -g pnpm@10.33.0 \
  && pnpm install --prod --frozen-lockfile \
  && pnpm store prune \
  && npm install -g bladebro@4.0.3 @tiny-fish/cli@0.46.0 \
  && bladebro --version \
  && tinyfish --version
# Optional engine CLIs baked into the image (space-separated npm packages).
# The opencode CLI (opencodeGo instance) is an operator choice, not a default.
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
ENV HOME=/data \
    RELAY_DATA_DIR=/data/.relay \
    RELAY_STATIC_DIR=/app/dist \
    RELAY_PORT=8799 \
    RELAY_WEBHOOK_PORT=8800 \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production
VOLUME ["/data"]
# The relay service runs harness+BFF via start.sh; the tools service overrides
# the command to run the Tool Layer instead.
COPY deploy/local/start-app.sh /usr/local/bin/start-app.sh
COPY deploy/local/start-tools.sh /usr/local/bin/start-tools.sh
RUN chmod +x /usr/local/bin/start-app.sh /usr/local/bin/start-tools.sh
USER maus
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -sf http://127.0.0.1:8799/api/health | grep -q relay || exit 1
CMD ["/usr/local/bin/start-app.sh"]
