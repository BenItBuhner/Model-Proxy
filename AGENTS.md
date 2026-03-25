## Cursor Cloud specific instructions

### Overview
Model-Proxy is a single-service Python FastAPI application (LLM inference proxy). It uses embedded SQLite -- no external databases or services required. The setup UI is plain HTML/CSS/JS with no build step.

### Development commands
See `README.md` for full CLI reference. Key commands (run from repo root with venv active):

- **Install deps**: `uv pip install -e ".[dev]"`
- **Lint**: `ruff check .` (or `model-proxy dev lint`)
- **Test**: `pytest -v` (or `model-proxy dev test --verbose`)
- **Start server**: `model-proxy start` (default port 9876)
- **Start with reload**: Use `uvicorn app.main:app --reload --host 0.0.0.0 --port 9876` because the CLI's `--reload` flag passes the app object instead of an import string, which uvicorn rejects
- **Health check**: `curl http://127.0.0.1:9876/health`
- **Setup UI**: `http://localhost:9876/setup/` (authenticate with `CLIENT_API_KEY` value from `.env`)

### Non-obvious gotchas
- The `config/models/` directory is empty on a fresh clone. This causes 3 test failures (`test_check_model_config`, `test_validate_model_config`, `test_validate_startup_success`) -- these are expected and not caused by environment issues.
- The `.env.example` ships with `CLIENT_API_KEY=ExampleKeyForClient`. Copy it to `.env` to get the server started without fuss.
- `FAIL_ON_STARTUP_VALIDATION` defaults to `false`, so the server starts even without any provider API keys configured. Validation warnings are printed but non-fatal.
- `uv.lock` is gitignored and not committed. Use `uv pip install -e ".[dev]"` rather than `uv sync`.
- The venv lives at `.venv/` in the repo root. Activate with `source .venv/bin/activate`.
