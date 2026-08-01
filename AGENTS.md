# AGENTS.md

## Cursor Cloud specific instructions

Runtime is **Bun** (installed at `~/.bun/bin/bun`, already on `PATH` via `~/.bashrc`). Node is present but the project runs on Bun; do not substitute `npm`/`node` for run/test/build. The startup update script already runs `bun install` at the repo root and in `web/`, so dependencies are refreshed automatically — no manual install needed.

There is a single service: a Bun/Hono API proxy that also serves the exported Next.js admin UI as static assets. Standard commands live in `package.json` (root) and `web/package.json`; see `README.md` for details. Notes below are only the non-obvious bits.

Running the API (`bun run dev`, hot reload):
- Requires a `.env` with `CLIENT_API_KEY` set (the app refuses unauthenticated `/v1/*` otherwise). Copy `.env.example` to `.env` and set a value; `.env` is gitignored.
- Listens on `http://127.0.0.1:9876`. Admin UI is at `/setup/`; log in on the "Request session" page using the `CLIENT_API_KEY` value.
- Serves the admin UI from `web/out` when `MODEL_PROXY_WEB_ROOT` is unset, so run `bun run build:web` once if `/setup/` 404s.

Static checks / build:
- Lint == typecheck: `bun run typecheck` (root) and `cd web && bun run typecheck`. The web `lint` script (`next lint`) is NOT configured in this repo — it drops into an interactive ESLint setup prompt and is not usable non-interactively; rely on `typecheck` instead.
- Builds: `bun run build` (API bundle → `dist/server.js`) and `bun run build:web` (Next static export → `web/out`).

Tests (`bun test`): ~387/396 pass. The ~9 failures are pre-existing and unrelated to environment setup — they are NOT caused by the toolchain. `config/providers/*` server-managed configs are only partially tracked in git, and the `opencode` and `nvidia` provider JSONs are absent, so `tests/opencode-provider.test.ts`, the `nvidia`-based cases in `tests/openai-provider.test.ts`, and one `tests/fallback-router.test.ts` case throw "Provider configuration not found" (also aggravated by provider-loader singleton search-path ordering across files). Do not treat these as regressions from env changes.
