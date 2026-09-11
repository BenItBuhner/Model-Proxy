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
- **Admin UI** — Next.js static app served at `/` (models, providers, keys, test bench, bundle import/export)

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
Admin UI: `http://127.0.0.1:9876/` (old `/setup/` links redirect)

## Quick start (local dev)

```bash
bun install

# Terminal 1 — API server (hot reload). On first boot an admin
# CLIENT_API_KEY is generated and printed to the console — no .env needed.
bun run dev

# Terminal 2 — admin UI (optional; or rely on Docker-built web-static)
cd apps/web && bun run dev
```

With only the API process, open the admin UI after building it once:

```bash
bun run build:web
# Serves from apps/web/out when MODEL_PROXY_WEB_ROOT is unset
```

## Project layout

Bun workspaces monorepo:

| Path | Purpose |
|------|---------|
| `packages/server/` | Engine: Hono server, routing, providers, config, storage (+ `tests/`) |
| `packages/contracts/` | Shared Zod schemas and API wire types (server + web) |
| `apps/web/` | Next.js admin UI (exported to `apps/web/out`, copied as `web-static` in Docker) |
| `config/providers/` | Provider endpoint + auth JSON (often gitignored locally; samples may ship in repo) |
| `config/models/` | Per logical model routing JSON (gitignored locally) |
| `config/templates/` | Templates for new provider/model files |
| `config/audio-models/` | Audio transcription routing |

## Configuration

### Data directory (config-first)

All persistent configuration lives in one data directory — default
`~/.model-proxy` (override with `--data-dir` or `MODEL_PROXY_DATA_DIR`):

| Path | Purpose |
|------|---------|
| `config/settings.json` | Plain runtime settings (managed from the admin UI) |
| `config/secrets.json` | API keys and other secrets, sealed with AES-256-GCM |
| `config/providers/` `config/models/` `config/audio-models/` | Routing JSON |
| `storage/` | SQLite, completions archive, analytics |

On first boot an admin `CLIENT_API_KEY` is generated, persisted to the
secrets store, and printed once to the console. Legacy `.env` files and
`config/` directories are migrated into the data dir automatically.

### Environment overrides (optional)

A `.env` file is never required. Any real environment variable (or `.env`
entry) overrides the UI-managed config store — useful for locked-down
deploys. Common overrides: `CLIENT_API_KEY`, `HOST`/`PORT`, `CORS_ORIGINS`,
`LOG_LEVEL`, `KEY_COOLDOWN_SECONDS`, `ENFORCE_TOOL_CALL_*`, provider keys
like `GROQ_API_KEY`. See [.env.example](.env.example) for the full list.

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
| GET | `/*` | Public assets; API calls need auth | Admin UI static assets (root) |
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

### Fusion Kernel (`fusion.engine: "kernel"`)

Fusion models orchestrate several upstream models behind one logical id. The
`kernel` engine is a deterministic coordinator for long-running agentic work
(OpenCode-style tool loops, math, research, SWE): it owns a durable
per-conversation **ledger** (intent, plan, verified findings, negative results),
dispatches ephemeral **bounded-context workers** across model families, and only
re-plans when the state actually changed.

| Turn | What the kernel does |
|------|----------------------|
| Fresh task | Blind proposal wave (one worker per family + extras on `alt_routings`), cross-family adversarial verification, claim clustering into accepted / disputed / rejected findings, escalation wave only if agreement < threshold and the last wave was still producing novel claims, then synthesis. |
| Tool continuation | Single executor call carrying the ledger brief — no decomposition, no subagents. A tool error triggers one bounded cross-family **repair** wave per failure signature; a step budget triggers a **checkpoint** wave. |
| Replay / rewind | Every worker call is a content-addressed work item (objective + capsule read-set + model + strategy + policy version), so identical work is served from the work cache with zero upstream calls. |

Short-answer tasks (math, multiple choice, yes/no) add an **answer vote**: every
proposer declares a `final_answer`, verifiers judge it explicitly, and the kernel
tallies a weighted, family-aware vote (one voice per family; a control proposer
always answers the verbatim task with no kernel framing). A decisive vote —
unanimous, or a ≥2-family majority confirmed by an uncommitted family — settles
the wave, skips redundant verification, blocks escalation, and switches synthesis
to presentation mode (low effort); split votes get full verification, a
de-herded escalation wave, and bounded (medium) synthesis.

Latency controls: proposal/verification waves settle on `wave_quorum` and cancel
stragglers after `straggler_grace_seconds` (or immediately once two families agree
and an audit confirms); verification is pipelined per candidate; per-band output
and time budgets (`worker_max_tokens_by_band`, `worker_timeout_seconds_by_band`,
`search_deadline_seconds`) bound each effort band. Upstream calls always stream
(also for non-streaming clients) so long generations survive origin timeouts, and
streamed responses end with a `: fusion-kernel {...}` SSE comment carrying the
kernel summary. Clients pick width with `reasoning_effort` (`high` → F3),
`fusion_effort`, or `{"fusion": {"effort": "max"}}`.

```bash
# Materialize a data dir with a techlitnow provider, glm-5.3 / kimi-k3 /
# deepseek-v4-pro-0813 logical models (alt upstream as sequential fallback;
# --hedge races them), and the fusion-max kernel model:
bun run scripts/bootstrap-fusion-max.ts --data-dir ~/.model-proxy \
  --base-url https://infer.techlitnow.com/v1 --api-key-env TECHLITNOW_API_KEY
# On a server that already exposes those logical models, only add fusion-max:
bun run scripts/bootstrap-fusion-max.ts --data-dir ~/.model-proxy --skip-upstreams
```

The template lives in `config/templates/fusion_max_template.json`; the legacy
divider → subagents → synthesis pipeline remains the default (`engine: "legacy"`).

Benchmarking (`packages/server/benchmarks/kernel-bench/`): public-dataset loaders
(MATH-500, AIME 2024/2025, MMLU-Pro categories, HumanEval with executed tests,
LegalBench), graders, a resumable runner that evaluates any model through the
proxy, a per-domain report, and a blind position-swapped pairwise judge for
open-ended writing.

```bash
cd packages/server
bun run benchmarks/kernel-bench/run.ts --suites math500,aime24,mmlu-law,humaneval --n 5 \
  --models glm-5.3,kimi-k3,deepseek-v4-pro-0813,fusion-max --out /tmp/kb/results.jsonl
bun run benchmarks/kernel-bench/report.ts --in /tmp/kb/results.jsonl --fusion fusion-max
bun run benchmarks/kernel-bench/judge.ts --n 6 --fusion fusion-max --out /tmp/kb/creative.jsonl
```

### Context window resolution (`GET /v1/models`)

For each logical model (primary route `model_routings[0]`):

1. Upstream provider `GET /v1/models` (cached)
2. `provider.models.<id>.context_length` in provider JSON
3. Route or model `context_window` in config
4. `DEFAULT_CONTEXT_WINDOW` env
5. `128000` system default

## CLI

The launcher is deliberately bare-bones — start the server, open the UI,
configure everything else in the browser:

```bash
# Launcher (opens the admin UI in your browser)
bun run apps/cli/src/main.ts            # or: bunx model-proxy (when published)

# Single-file native binary (no Bun install needed on the target machine)
bun run build:cli                        # -> dist/model-proxy
./dist/model-proxy --port 9876 --data-dir ~/.model-proxy
```

Flags: `--host`, `--port`, `--data-dir`, `--no-open`, `--version`, `--help`.

The raw server entrypoint (no browser handling; used by Docker) is
`packages/server/src/cli/main.ts` with `--host`, `--port`, `--data-dir`,
`--log-level`.

## Desktop app (Electron)

`apps/desktop` wraps the exact same engine and UI in an installable shell:
the Electron main process spawns the compiled server binary as a sidecar on
a free localhost port, stores all data under the OS app-data path, and
auto-logs-in with a per-install admin key — no login screen, no terminal.

```bash
bun run build:cli && bun run build:web       # build the sidecar + UI once
cd apps/desktop && bun install
bun run start                                # launch the app
bun run dist                                 # build installers (dmg/nsis/AppImage/deb)
```

The desktop app is intentionally NOT part of the Bun workspaces so normal
installs never download Electron.

## Scripts

```bash
bun run dev          # API with --hot
bun run start        # API production mode
bun test             # test suite
bun run typecheck    # tsc --noEmit
bun run build:web    # build admin UI → apps/web/out
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

Tests live under `packages/server/tests/` (and `apps/web/tests/` for UI helpers). Config loaders use a temp directory in tests; production config is read from `config/` search paths (cwd, `~/.model-proxy/config`, package `config/`).

## License

MIT (see repository license file if present).
