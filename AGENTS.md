# AGENTS.md

## Cursor Cloud specific instructions

Runtime is **Bun** (installed at `~/.bun/bin/bun`, already on `PATH` via `~/.bashrc`). Node is present but the project runs on Bun; do not substitute `npm`/`node` for run/test/build. This is a Bun-workspaces monorepo (`packages/contracts`, `packages/server`, `apps/web`); a single `bun install` at the repo root installs every workspace.

There is a single service: a Bun/Hono API proxy that also serves the exported Next.js admin UI as static assets. Standard commands live in the root `package.json` (they delegate to the workspaces); see `README.md` for details. Notes below are only the non-obvious bits.

Running the API (`bun run dev`, hot reload):
- Requires a `.env` with `CLIENT_API_KEY` set (the app refuses unauthenticated `/v1/*` otherwise). Copy `.env.example` to `.env` and set a value; `.env` is gitignored.
- Listens on `http://127.0.0.1:9876`. Admin UI is at `/setup/`; log in on the "Request session" page using the `CLIENT_API_KEY` value.
- Serves the admin UI from `web/out` when `MODEL_PROXY_WEB_ROOT` is unset, so run `bun run build:web` once if `/setup/` 404s.

Static checks / build:
- Lint == typecheck: `bun run typecheck` at the root checks all three workspaces. The web `lint` script (`next lint`) is NOT configured in this repo — it drops into an interactive ESLint setup prompt and is not usable non-interactively; rely on `typecheck` instead.
- Builds: `bun run build` (API bundle → `dist/server.js`) and `bun run build:web` (Next static export → `apps/web/out`).

Tests: `bun run test` at the root runs the server suite (`packages/server/tests/`) then the web suite (`apps/web/tests/`). All tests pass; treat any failure as a regression.
