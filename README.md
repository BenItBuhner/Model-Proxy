# Model-Proxy - Centralized Inference Endpoint

A production-ready FastAPI application that provides a unified, multi-provider LLM inference proxy with automatic API key fallback, rate limiting, structured logging, and health monitoring. Supports OpenAI and Anthropic APIs with seamless format conversion and cross-provider routing.

**Warning:** This repo is *functional* but incomplete and may undergo further restructuring; model schemas, API handling, and execution may vary as development progresses.

![Model Proxy Banner](assets/github/model-proxy-banner.png)

## Features

- **Multi-Provider Support**: Route requests to OpenAI or Anthropic based on model configuration
- **API Key Fallback**: Automatic failover to backup API keys when rate limits or errors occur
- **Circuit Breaker Pattern**: Failed keys enter cooldown period before retry
- **Format Conversion**: Seamless conversion between OpenAI and Anthropic API formats
- **Streaming Support**: Full Server-Sent Events (SSE) streaming for both providers

## Installation

### Prerequisites

- Python 3.9 or higher
- [uv](https://github.com/astral-sh/uv) (recommended Python package manager)

### Option 1: Installation with uv (Recommended)

```bash
# Clone the repository
git clone https://github.com/BenItBuhner/model-proxy.git
cd model-proxy

# Install in editable mode (development)
uv pip install -e .
```

After installation, the `model-proxy` command will be available globally.

### Option 2: Standard Installation with uv

```bash
# Install the package (creates wheel)
uv install
# or
pip install .
```

### Option 3: Using uv tool (Isolated Environment)

```bash
# Install as a tool in an isolated environment
uv tool install .

# The command is available in your PATH
model-proxy --help
```

### Option 4: Installation without uv (Standard pip)

```bash
# Clone the repository
git clone https://github.com/BenItBuhner/model-proxy.git
cd model-proxy

# Install in editable mode
pip install -e .
```

### Quick Start

After installation:

```bash
# Check your setup
model-proxy doctor

# Start the server
model-proxy start
```

## Configuration

### Environment Variables

Create a `.env` file in the project root or set the following environment variables:

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

To add a new model, create a JSON file in `config/models/` named `<logical_model>.json` with the routing configuration.

Example `config/models/gpt-5-2.json`:

```json
{
  "logical_name": "gpt-5.2",
  "timeout_seconds": 60,
  "model_routings": [
    {
      "provider": "openai",
      "model": "gpt-5.2"
    },
    {
      "provider": "azure",
      "model": "gpt-5.2"
    }
  ],
  "fallback_model_routings": ["gpt-5.1"]
}
```

## CLI Reference

The `model-proxy` command provides a comprehensive CLI for managing the application.

### Core Commands

#### `model-proxy start`
Start the model-proxy server.

```bash
model-proxy start [OPTIONS]
```

**Options:**
- `--host, -h`: Host to bind to (default: `127.0.0.1`)
- `--port, -p`: Port to run on (default: `9876`)
- `--reload`: Enable auto-reload for development (default: `False`)
- `--workers, -w`: Number of worker processes (default: `1`)
- `--log-level, -l`: Log level (default: `info`)
- `--env-file`: Load environment from specific file

**Examples:**
```bash
# Start with defaults
model-proxy start

# Start on custom port
model-proxy start --port 8000

# Development mode with auto-reload
model-proxy start --reload

# Production mode with multiple workers
model-proxy start --workers 4 --host 0.0.0.0 --log-level warning

# Load custom environment file
model-proxy start --env-file .env.production
```

#### `model-proxy health`
Check the health of a running server.

```bash
model-proxy health [OPTIONS]
```

**Options:**
- `--endpoint, -e`: Server endpoint URL (default: `http://127.0.0.1:9876`)
- `--detailed, -d`: Show detailed component status

**Examples:**
```bash
# Basic health check
model-proxy health

# Check specific endpoint
model-proxy health --endpoint http://localhost:8000

# Detailed component status
model-proxy health --detailed
```

#### `model-proxy version`
Show version information.

```bash
model-proxy version [OPTIONS]
```

**Options:**
- `--verbose, -v`: Show detailed version information including dependencies

**Examples:**
```bash
# Show version
model-proxy version

# Show detailed information
model-proxy version --verbose
```

### Configuration Commands

#### `model-proxy config list`
List all available models.

```bash
model-proxy config list [OPTIONS]
```

**Options:**
- `--format, -f`: Output format - `table` or `json` (default: `table`)

**Examples:**
```bash
# List models in table format
model-proxy config list

# List models as JSON
model-proxy config list --format json
```

#### `model-proxy config validate`
Validate all model configurations.

```bash
model-proxy config validate
```

**Examples:**
```bash
# Validate all configurations
model-proxy config validate
```

#### `model-proxy config show`
Show configuration for a specific model.

```bash
model-proxy config show MODEL
```

**Examples:**
```bash
# Show configuration for a model
model-proxy config show gpt-5.2
```

#### `model-proxy add provider`
Add a new LLM provider interactively or via flags.

```bash
model-proxy add provider [OPTIONS]
```

**Options:**
- `--list, -l`: List available providers without adding
- `--name, -n`: Provider identifier (non-interactive)
- `--display-name, -d`: Provider display name (non-interactive)
- `--base-url, -u`: Provider base URL (non-interactive)
- `--format, -f`: Provider format: `openai`, `anthropic`, `gemini`, `azure` (non-interactive)
- `--overwrite, -o`: Overwrite existing provider

**Examples:**
```bash
# Add provider interactively
model-proxy add provider

# List available providers
model-proxy add provider --list

# Add provider non-interactively
model-proxy add provider --name myapi --display-name "My API" --base-url https://api.example.com --format openai
```

#### `model-proxy add model`
Add model configurations interactively or via flags.

```bash
model-proxy add model [OPTIONS]
```

**Options:**
- `--list, -l`: List models without configuring
- `--name, -n`: Logical model name (non-interactive)
- `--provider, -p`: Provider name (non-interactive)
- `--model, -m`: Model ID from provider (non-interactive)
- `--timeout, -t`: Timeout in seconds (default: 240)
- `--custom, -c`: Add as custom model to cache only
- `--overwrite, -o`: Overwrite existing model config

**Examples:**
```bash
# Add model interactively
model-proxy add model

# List available models
model-proxy add model --list

# Add model non-interactively
model-proxy add model --name gpt4-fallback --provider openai --model gpt-4 --timeout 120

# Add custom model
model-proxy add model --custom --provider openai --model gpt-4-custom
```

#### `model-proxy add key`
Add API keys interactively or via flags.

```bash
model-proxy add key [OPTIONS]
```

**Options:**
- `--list, -l`: List API keys without adding
- `--provider, -p`: Provider name (non-interactive)
- `--key, -k`: API key value (non-interactive, use with caution)
- `--env-var, -e`: Custom environment variable name

**Examples:**
```bash
# Add API key interactively
model-proxy add key

# List configured keys
model-proxy add key --list

# Add key non-interactively
model-proxy add key --provider openai --key sk-xxx

# Add key with custom env variable
model-proxy add key --provider openai --key sk-xxx --env-var OPENAI_API_KEY_2
```

### Diagnostics Commands

#### `model-proxy doctor`
Run comprehensive system diagnostics.

```bash
model-proxy doctor [OPTIONS]
```

**Options:**
- `--fix`: Attempt to fix issues (experimental)

**Examples:**
```bash
# Run diagnostics
model-proxy doctor

# Attempt to fix issues
model-proxy doctor --fix
```

The doctor command checks:
- ✓ Python version compatibility
- ✓ Required dependencies installation
- ✓ Configuration file structure
- ✓ Environment variables
- ✓ Provider API keys
- ✓ Database connectivity
- ✓ Model configurations

#### `model-proxy env check`
Check environment variable configuration.

```bash
model-proxy env check
```

**Examples:**
```bash
# Check environment variables
model-proxy env check
```

### API Key Management

#### `model-proxy keys list`
List configured API keys (redacted for security).

```bash
model-proxy keys list
```

**Examples:**
```bash
# List all API keys (redacted)
model-proxy keys list
```

#### `model-proxy keys test`
Test API key validity for a provider.

```bash
model-proxy keys test PROVIDER
```

**Examples:**
```bash
# Test OpenAI API keys
model-proxy keys test openai

# Test Anthropic API keys
model-proxy keys test anthropic
```

### Database Management

#### `model-proxy db stats`
Show database statistics.

```bash
model-proxy db stats
```

**Examples:**
```bash
# Show database statistics
model-proxy db stats
```

#### `model-proxy db reset`
Reset database (development only - deletes all data).

```bash
model-proxy db reset [OPTIONS]
```

**Options:**
- `--confirm, -y`: Skip confirmation prompt

**Examples:**
```bash
# Reset database (with confirmation prompt)
model-proxy db reset

# Reset database without confirmation
model-proxy db reset --confirm
```

### Development Tools

#### `model-proxy dev shell`
Open an interactive Python shell with the app loaded.

```bash
model-proxy dev shell
```

**Available objects:**
- `app` - FastAPI application
- `db` - Database session
- `config_loader` - Model configuration loader

**Examples:**
```bash
# Start interactive shell
model-proxy dev shell
```

#### `model-proxy dev test`
Run the test suite.

```bash
model-proxy dev test [OPTIONS]
```

**Options:**
- `--verbose, -v`: Show test output

**Examples:**
```bash
# Run tests
model-proxy dev test

# Run tests with verbose output
model-proxy dev test --verbose
```

#### `model-proxy dev lint`
Run linter and formatter checks.

```bash
model-proxy dev lint [OPTIONS]
```

**Options:**
- `--fix, -f`: Automatically fix linting issues

**Examples:**
```bash
# Check for linting issues
model-proxy dev lint

# Fix linting issues automatically
model-proxy dev lint --fix
```

### Help

```bash
# Show main help
model-proxy --help
# or
model-proxy help

# Show specific command help
model-proxy start --help
model-proxy config --help
model-proxy db --help
```

## Running the Application

### Using the CLI (Recommended)

```bash
# Start the server with default settings
model-proxy start

# Start on custom port with auto-reload (development)
model-proxy start --port 8000 --reload

# Start in production mode
model-proxy start --host 0.0.0.0 --workers 4 --log-level info
```

The API will be available at the specified host and port (default: `http://127.0.0.1:9876`)

### Docker

Build the Docker image:
```bash
docker build -t model-proxy .
```

Run the container:
```bash
docker run -d -p 9876:9876 \
  -e CLIENT_API_KEY=your_client_key \
  -e OPENAI_API_KEY_1=your_openai_key \
  -e ANTHROPIC_API_KEY_1=your_anthropic_key \
  model-proxy
```

Override CLI flags at runtime:
```bash
docker run -d -p 8000:8000 \
  -e CLIENT_API_KEY=your_client_key \
  model-proxy start --port 8000 --host 0.0.0.0
```

### Docker Compose

For local development:
```bash
# Default service
docker-compose up

# Development service with auto-reload
docker-compose --profile development up
```

For production:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Development Workflow

### Quick Development Setup

```bash
# 1. Install the CLI in editable mode
uv pip install -e .

# 2. Run diagnostics to check your setup
model-proxy doctor

# 3. Check environment variables
model-proxy env check

# 4. Validate configurations
model-proxy config validate

# 5. List available models
model-proxy config list

# 6. Start the server in development mode
model-proxy start --reload
```

### Running Tests

```bash
# Run all tests
model-proxy dev test

# Run tests with verbose output
model-proxy dev test --verbose

# Or run directly with pytest
pytest -v
```

### Code Quality

```bash
# Check for linting and formatting issues
model-proxy dev lint

# Automatically fix issues
model-proxy dev lint --fix
```

### Interactive Python Shell

```bash
# Start interactive shell with app loaded
model-proxy dev shell

# In the shell, you can:
>>> config_loader.get_available_models()
>>> db.query(RequestLog).count()
>>> app.routes[0].path
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

### Health Check Endpoints

#### GET `/health`
Basic health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

#### GET `/health/detailed`
Detailed health check with component status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "uptime_seconds": 3600,
  "components": {
    "database": {
      "status": "healthy",
      "response_time_ms": 5
    },
    "providers": {
      "openai": {
        "status": "healthy",
        "keys_available": 3
      }
    },
    "model_config": {
      "status": "healthy",
      "models_count": 10
    }
  }
}
```

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

## Troubleshooting

### Installation Issues

**Problem:** `model-proxy` command not found after installation

**Solution:**
```bash
# If using uv tool, update your shell
uv tool update-shell

# Or ensure your virtual environment is activated
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows
```

### Server Startup Issues

**Problem:** Port already in use

**Solution:**
```bash
# Find the process using the port (Linux/Mac)
lsof -i :9876

# Find the process using the port (Windows)
netstat -ano | findstr :9876

# Use a different port
model-proxy start --port 8000
```

**Problem:** Missing environment variables

**Solution:**
```bash
# Run diagnostics
model-proxy doctor

# Check environment
model-proxy env check

# Create .env file from example
cp .env.example .env
# Edit .env and add required variables
```

### Database Issues

**Problem:** Database connection errors

**Solution:**
```bash
# Reset database (development only)
model-proxy db reset --confirm

# Check database stats
model-proxy db stats
```

### Configuration Issues

**Problem:** Models not loading

**Solution:**
```bash
# Validate configurations
model-proxy config validate

# List available models
model-proxy config list

# Check specific model
model-proxy config show <model-name>
```

### Getting Help

```bash
# Show all available commands
model-proxy --help

# Show help for specific command
model-proxy start --help

# Run diagnostics
model-proxy doctor
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
# Install in editable mode with dev dependencies
uv pip install -e ".[dev]"

# Run tests
model-proxy dev test

# Run linting
model-proxy dev lint

# Start development server
model-proxy start --reload
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Built with [FastAPI](https://fastapi.tiangolo.com/)
- Package management with [uv](https://github.com/astral-sh/uv)
- CLI powered by [Typer](https://typer.tiangolo.com/)
- Beautiful output with [Rich](https://rich.readthedocs.io/)
