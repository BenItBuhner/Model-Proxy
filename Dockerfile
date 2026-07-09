# ---------- Stage 1: build the Next.js admin UI ----------
FROM oven/bun:1.1.38-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile
COPY web ./
ENV NODE_ENV=production
RUN bun run build

# ---------- Stage 2: install proxy runtime deps ----------
FROM oven/bun:1.1.38-alpine AS server-deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ---------- Stage 3: final runtime ----------
FROM oven/bun:1.1.38-alpine
WORKDIR /app

COPY package.json bun.lock* ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY src ./src
COPY shared ./shared
COPY tsconfig.json ./

COPY --from=web-build /app/web/out ./web-static

RUN mkdir -p /app/config/providers /app/config/models /app/config/templates /app/.storage \
    && chown -R bun:bun /app/config /app/.storage

USER bun

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9876 \
    MODEL_PROXY_WEB_ROOT=/app/web-static \
    MODEL_PROXY_ENV_FILE=/app/.env

EXPOSE 9876

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:9876/health || exit 1

CMD ["bun", "run", "src/cli/main.ts", "--host", "0.0.0.0", "--port", "9876"]
