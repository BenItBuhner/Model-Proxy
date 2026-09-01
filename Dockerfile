# ---------- Stage 1: build the Next.js admin UI ----------
FROM oven/bun:1.1.38-alpine AS web-build
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ENV NODE_ENV=production
RUN bun run --cwd apps/web build

# ---------- Stage 2: install proxy runtime deps ----------
FROM oven/bun:1.1.38-alpine AS server-deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --production

# ---------- Stage 3: final runtime ----------
FROM oven/bun:1.1.38-alpine
WORKDIR /app

COPY package.json bun.lock* ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY packages/contracts packages/contracts
COPY packages/server packages/server

COPY --from=web-build /app/apps/web/out ./web-static

RUN mkdir -p /app/config/providers /app/config/models /app/config/templates /app/.storage /app/data \
    && chown -R bun:bun /app/config /app/.storage /app/data

USER bun

# All persistent state (config store, providers/models JSON, secrets) lives
# under /app/data — mount a single volume there. Legacy /app/config and
# /app/.env mounts keep working: they are read as fallbacks and migrated into
# the data dir on first boot.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9876 \
    MODEL_PROXY_WEB_ROOT=/app/web-static \
    MODEL_PROXY_DATA_DIR=/app/data

EXPOSE 9876

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:9876/health || exit 1

CMD ["bun", "run", "packages/server/src/cli/main.ts", "--host", "0.0.0.0", "--port", "9876"]
