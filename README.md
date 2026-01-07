# Model Proxy

A production-ready FastAPI application that provides a unified, multi-provider LLM inference proxy with automatic API key fallback, rate limiting, structured logging, and health monitoring. Supports OpenAI and Anthropic APIs with seamless format conversion and cross-provider routing.

**Warning:** This repo is *functional* but incomplete and may undergo further restructuring; model schemas, API handling, and execution may vary as development progresses.

![Model Proxy Banner](assets/github/model-proxy-banner.png)

## Installation

### From Source (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/BenItBuhner/model-proxy.git
cd model-proxy
```

2. Install with uv:
```bash
# Install uv if you don't have it
pip install uv

# Install the package and dependencies
uv pip install .

# Or install in development mode
uv pip install -e .
```

3. Set up environment variables (see [Configuration](#configuration) below)

#### Quick Start with Wrapper Script

If you don't want to install the package system-wide, you can use the provided wrapper script:

```bash
# Make the script executable (if needed)
chmod +x scripts/model-proxy

# Run the model proxy
./scripts/model-proxy run --port 8000
```

### Alternative Installation Methods

You can also install the package using pip directly:
```bash
pip install .
```

Or install from a git repository:
```bash
pip install git+https://github.com/BenItBuhner/model-proxy.git
```

## Usage

### Command Line Interface

The `model-proxy` command provides a CLI interface for running the server:

#### Basic Usage
```bash
# Start the server with default settings (host: 0.0.0.0, port: 8000)
model-proxy run

# Start on a specific port
model-proxy run --port 9876

# Start on a specific host and port
model-proxy run --host localhost --port 8080

# Enable auto-reload for development
model-proxy run --reload

# Use multiple workers for production
model-proxy run --workers 4

# Set custom log level
model-proxy run --log-level debug
```

#### Available Options
- `--host TEXT`: Host to bind the server to (default: "0.0.0.0")
- `--port INTEGER`: Port to bind the server to (default: 8000)
- `--reload`: Enable auto-reload for development
- `--workers INTEGER`: Number of worker processes (default: 1, only used when reload=False)
- `--log-level TEXT`: Log level for the server (default: "info")

#### Help and Version
```bash
# Show help
model-proxy --help

# Show version
model-proxy version
```

### API Access

Once the server is running, access the API at:
- **Local**: http://localhost:8000
- **Network**: http://0.0.0.0:8000
- **Interactive Docs**: http://localhost:8000/docs
- **Alternative Docs**: http://localhost:8000/redoc

## Configuration

### Environment Variables

Create a `.env` file or set the following environment variables:

#### Required
- `CLIENT_API_KEY`: API key for client authentication (required for all requests)

#### Provider API Keys
- `OPENAI_API_KEY`: Primary OpenAI API key (or `OPENAI_API_KEY_1`)
- `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, ...: Additional OpenAI API keys for fallback
- `ANTHROPIC_API_KEY`: Primary Anthropic API key (or `ANTHROPIC_API_KEY_1`)
- `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, ...: Additional Anthropic API keys for fallback

#### Optional
- `KEY_COOLDOWN_SECONDS`: Cooldown period for failed API keys (default: 300 seconds / 5 minutes)
- `REQUIRE_CLIENT_API_KEY`: Set to "true" to fail startup if CLIENT_API_KEY is missing (default: "false")
- `FAIL_ON_STARTUP_VALIDATION`: Set to "true" to fail startup on validation errors (default: "false")
- `CORS_ORIGINS`: Comma-separated list of allowed CORS origins (default: "*")
- `RATE_LIMIT_REQUESTS_PER_MINUTE`: Maximum requests per minute per client (default: 60)
- `RATE_LIMIT_TOKENS_PER_MINUTE`: Maximum tokens per minute per client (default: 100000)

### Provider Configuration

Provider settings are configured in JSON files under `config/providers/`:

- `config/providers/openai.json`: OpenAI provider configuration
- `config/providers/anthropic.json`: Anthropic provider configuration

Each provider config includes:
- `endpoints`: Base URL and endpoint paths
- `authentication`: Header format and authentication method
- `api_key_env_patterns`: Environment variable patterns for API keys
- `request_config`: Timeouts, retries, and default parameters
- `proxy_support`: Optional proxy URL override for OpenAI-compatible endpoints

### Model Configuration

To add a new model, create a JSON file in `config/models/` named `<logical_model>.json` with the routing configuration. Models are defined as individual routing configuration files under `config/models/`. Each logical model has its own JSON file named `<logical_model>.json` that describes routing (primary provider, fallbacks, timeouts, and optional overrides for API keys or wire protocol).

Example `config/models/gpt-5-2.json` (simplified):

```json
{
  "logical_name": "gpt-5.2",
  "timeout_seconds": 60,
  "model_routings": [
    {
      "id": "primary",
      "provider": "openai",
      "model": "gpt-5.2"
    },
    {
      "id": "secondary",
      "provider": "azure",
      "model": "gpt-5.2"
    }
  ],
  "fallback_model_routings": ["gpt-5.1"]
}
```

Notes:
- The new routing system reads per-model JSON files in `config/models/` using `app.routing.config_loader.ModelConfigLoader`.
- Use `config_loader.get_available_models()` to list logical models programmatically.
- `wire_protocol` and `api_key_env` are optional per-route overrides. If omitted, the provider config determines the wire protocol and API key env var patterns.
- If you previously used a single `config/models.json` (the legacy flat mapping), you should migrate to per-model files by creating one JSON file per logical model in `config/models/`. A migration script can be added to automate splitting the flat mapping into per-model files; otherwise create files by hand using the example above.

## Features

- **Multi-Provider Support**: Route requests to OpenAI or Anthropic based on model configuration
- **API Key Fallback**: Automatic failover to backup API keys when rate limits or errors occur
- **Circuit Breaker Pattern**: Failed keys enter cooldown period before retry
- **Format Conversion**: Seamless conversion between OpenAI and Anthropic API formats (not perfect yet)
- **Streaming Support**: Full Server-Sent Events (SSE) streaming for both providers
- **Structured Logging**: Comprehensive request/response logging to SQLite database
- **Rate Limiting**: Configurable per-client rate limits (requests and tokens per minute)
- **Health Checks**: Basic and detailed health monitoring endpoints
- **CORS Support**: Configurable Cross-Origin Resource Sharing
- **Error Handling**: Provider-standardized error responses matching OpenAI/Anthropic formats
- **CLI Interface**: Easy-to-use command-line interface with multiple configuration options

## Development

For developers who want to contribute or run the application in development mode:

### Local Development Setup

1. Clone the repository:
```bash
git clone https://github.com/BenItBuhner/model-proxy.git
cd model-proxy
```

2. Install dependencies:
```bash
# Install uv if you don't have it
pip install uv

# Install project dependencies
uv sync

# Install in development mode
uv pip install -e .
```

3. Run with auto-reload for development:
```bash
# Using the CLI (recommended)
model-proxy run --reload

# Or using uvicorn directly
uv run uvicorn app.main:app --reload --port 8000
```

4. The API will be available at http://localhost:8000

### Docker Development

Build the Docker image:
```bash
docker build -t model-proxy .
```

Run the container:
```bash
docker run -d -p 8000:8000 \
  -e CLIENT_API_KEY=your_client_key \
  -e OPENAI_API_KEY_1=your_openai_key \
  -e ANTHROPIC_API_KEY_1=your_anthropic_key \
  model-proxy
```

### Docker Compose

For local development:
```bash
docker-compose up
```

For production:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

## API Endpoints

### OpenAI-Compatible Endpoints

#### POST `/v1/chat/completions`
OpenAI-compatible chat completions endpoint (non-streaming).

**Request:**
```json
{
  "model": "gpt-5.2",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 100
}
```

**Response:** Standard OpenAI chat completion response format.

#### POST `/v1/chat/completions-stream`
OpenAI-compatible streaming chat completions endpoint.

**Request:** Same as `/v1/chat/completions` but returns Server-Sent Events stream.

**Response:** SSE stream with OpenAI-formatted chunks.

### Anthropic-Compatible Endpoints

#### POST `/v1/messages`
Anthropic-compatible messages endpoint (non-streaming).

**Request:**
```json
{
  "model": "claude-4.5-opus",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "max_tokens": 100,
  "temperature": 0.7
}
```

**Response:** Standard Anthropic message response format.

#### POST `/v1/messages-stream`
Anthropic-compatible streaming messages endpoint.

**Request:** Same as `/v1/messages` but returns Server-Sent Events stream.

**Response:** SSE stream with Anthropic-formatted chunks.

## Authentication

All endpoints require authentication via the `Authorization` header:

```
Authorization: Bearer <CLIENT_API_KEY>
```

Or simply:
```
Authorization: <CLIENT_API_KEY>
```

The `Bearer` prefix is optional and case-insensitive.
