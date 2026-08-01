# Model-Proxy

OpenAI- and Anthropic-compatible LLM proxy on **Bun** and **TypeScript**. Route logical model names to multiple upstream providers with API-key rotation, cooldowns, format conversion, streaming, optional tool-call enforcement, and a built-in admin UI.

![Model Proxy Banner](assets/github/model-proxy-banner.png)

## Features

- **Logical models** — `config/models/<name>.json` maps a client-facing id to one or more provider routes and fallbacks
- **Multi-provider routing** — OpenAI-compatible and Anthropic wire protocols (Groq, Cerebras, Gemini, OpenRouter, Nahcrof, etc.)
- **API key fallback** — rotate keys and cool down failed keys per provider
- **Format conversion** — OpenAI ↔ Anthropic at the proxy boundary
- **Streaming** — SSE for chat completions
- **Context window metadata** — `GET /v1/models` exposes `context_window`, `context_length`, and `limit.context` for harness compaction
- **Audio** — OpenAI-style `/v1/audio/transcriptions` with provider routing
- **Admin UI** — Next.js static app at `/setup/` (models, providers, env, test bench, bundle import/export)

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (runtime and tests)
- Docker optional (recommended for production)

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env: set CLIENT_API_KEY and provider API keys

docker compose build
docker compose up -d

curl -s http://127.0.0.1:9876/health
curl -s -H "Authorization: Bearer $CLIENT_API_KEY" http://127.0.0.1:9876/v1/models
```

Default listen address: `http://127.0.0.1:9876`  
Admin UI: `http://127.0.0.1:9876/setup/`

## Quick start (local dev)

```bash
cp .env.example .env
bun install

# Terminal 1 — API server (hot reload)
bun run dev

# Terminal 2 — admin UI (optional; or rely on Docker-built web-static)
cd web && bun install && bun run dev
```

With only the API process, open `/setup/` after building the UI once:

```bash
cd web && bun install && bun run build
# Serves from web/out when MODEL_PROXY_WEB_ROOT is unset
```

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | Hono server, routing, providers, CLI entry |
| `shared/schemas/` | Zod schemas for config and wire formats |
| `web/` | **Current** Next.js admin UI (exported to `web/out`, copied as `web-static` in Docker) |
| `config/providers/` | Provider endpoint + auth JSON (often gitignored locally; samples may ship in repo) |
| `config/models/` | Per logical model routing JSON (gitignored locally) |
| `config/templates/` | Templates for new provider/model files |
| `config/audio-models/` | Audio transcription routing |
| `tests/` | `bun test` integration tests |

There is no Python application in this tree. The v1 FastAPI codebase was replaced by this v2 TypeScript implementation.

## Configuration

### Environment (`.env`)

| Variable | Description |
|----------|-------------|
| `CLIENT_API_KEY` | **Required.** Bearer token clients must send |
| `HOST` / `PORT` | Bind address (default `127.0.0.1:9876`) |
| `CORS_ORIGINS` | Comma-separated origins or `*` |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `DEFAULT_CONTEXT_WINDOW` | Fallback context size (tokens) when upstream/config omit it |
| `UPSTREAM_MODELS_CACHE_TTL_SECONDS` | Cache TTL for provider `/v1/models` catalogs (default `3600`) |
| `UPSTREAM_MODELS_FETCH_TIMEOUT_MS` | Max wait on first upstream catalog fetch (default `2000`) |
| `KEY_COOLDOWN_SECONDS` | API key cooldown after failures |
| `ENFORCE_TOOL_CALL_*` | Global tool-call enforcement defaults |
| Provider keys | e.g. `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY` |

See [.env.example](.env.example) for the full list.

### Logical model example

`config/models/turbo.json`:

```json
{
  "logical_name": "turbo",
  "timeout_seconds": 20,
  "default_cooldown_seconds": 10,
  "context_window": 131072,
  "model_routings": [
    { "provider": "cerebras", "model": "zai-glm-4.7" }
  ],
  "fallback_model_routings": []
}
```

Optional `context_window` on the model or on a route overrides discovery when upstream metadata is missing.

## API surface

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | No | Liveness |
| GET | `/health/ready` | No | Readiness for blue/green deploys |
| GET | `/health/detailed` | No | Models/providers counts, readiness, deploy metadata |
| GET | `/v1/models` | Bearer | OpenAI list + context metadata |
| POST | `/v1/chat/completions` | Bearer | OpenAI chat |
| POST | `/v1/chat/completions/stream` | Bearer | Forces `stream: true` |
| POST | `/v1/responses` | Bearer | OpenAI Responses, native or routed |
| WS | `/v1/responses` | Bearer | Streaming `response.create` events |
| GET | `/v1/responses/:responseId` | Bearer | Retrieve a stored response |
| DELETE | `/v1/responses/:responseId` | Bearer | Delete a stored response |
| POST | `/v1/messages` | Bearer | Anthropic messages |
| POST | `/v1/audio/transcriptions` | Bearer | Audio STT |
| GET | `/setup/*` | Session or Bearer | Admin UI static assets |
| `/v1/admin/*` | Session or Bearer | Config CRUD, logs, bundle import |

Chat responses keep the **logical** `model` id the client requested.

Responses requests use the logical model's routing graph. Routes with
`wire_protocol: "responses"` invoke a provider's native Responses transport;
OpenAI-compatible and Anthropic routes are converted at the protocol boundary.
Stored responses and canonical input/output items back `previous_response_id`
chaining, with SQLite persistence, TTL, and owner isolation. The official SDK
conformance harness can be run against an isolated or deployed instance with:

```bash
CLIENT_API_KEY=... MODEL_PROXY_BASE=http://127.0.0.1:9876/v1 \
  MODEL_PROXY_MODEL=glm-5.2 bun run test:responses-sdk
```

For a native provider, configure `endpoints.responses` and optionally
`endpoints.responses_streaming` in addition to the normal completion paths.

### Context window resolution (`GET /v1/models`)

For each logical model (primary route `model_routings[0]`):

1. Upstream provider `GET /v1/models` (cached)
2. `provider.models.<id>.context_length` in provider JSON
3. Route or model `context_window` in config
4. `DEFAULT_CONTEXT_WINDOW` env
5. `128000` system default

## CLI

The process entrypoint is Bun, not a separate Python package:

```bash
bun run start
# or
bun run ./src/cli/main.ts --host 0.0.0.0 --port 9876 --log-level info
```

Docker CMD uses the same entrypoint. Supported flags: `--host`, `--port`, `--log-level`. The optional `start` positional argument is accepted for compatibility.

## Scripts

```bash
bun run dev          # API with --hot
bun run start        # API production mode
bun test             # test suite
bun run typecheck    # tsc --noEmit
bun run build:web    # build admin UI → web/out
```

## Docker

- **Image:** `model-proxy:v2` (see [Dockerfile](Dockerfile))
- **Compose (dev):** [docker-compose.yml](docker-compose.yml) — bind-mounts `./config` and `./.env`
- **Compose (prod):** [docker-compose.prod.yml](docker-compose.prod.yml) — named volume for config
- **Compose (zero-downtime):** [docker-compose.bluegreen.yml](docker-compose.bluegreen.yml) — Caddy frontdoor on `:9876`, blue/green backends on loopback debug ports `9877`/`9878`

```bash
# Single-container dev path. This recreates the container and can interrupt
# active agents, so do not use it for production rebuilds.
docker compose up -d --build
docker compose -f docker-compose.prod.yml up -d --build

# Production-safe blue/green path.
scripts/deploy-model-proxy.sh status
scripts/deploy-model-proxy.sh bootstrap   # first blue/green start
scripts/deploy-model-proxy.sh deploy      # rebuild + switch + drain old
scripts/deploy-model-proxy.sh rollback    # flip back to previous image/color
```

In blue/green mode, host port `9876` belongs to Caddy. The backend containers must not publish `9876` directly; the deploy script starts the inactive color, waits for `/health/ready`, reloads Caddy to the new upstream, then gives the old color a long graceful shutdown window for active streams.

For the one-time migration from the legacy single `model-proxy` container, `bootstrap` can prepare the blue backend while the legacy container still serves `9876`, but Caddy cannot bind `9876` until the legacy container stops. The script prints the exact stop/rerun command at that point; future `deploy` runs are blue/green and avoid the port gap.

## Development

```bash
bun test
bun run typecheck
```

Tests live under `tests/`. Config loaders use a temp directory in tests; production config is read from `config/` search paths (cwd, `~/.model-proxy/config`, package `config/`).

## License

MIT (see repository license file if present).
