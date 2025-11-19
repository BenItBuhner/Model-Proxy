# Centralized Inference Endpoint

A production-ready FastAPI application that provides a unified, multi-provider LLM inference proxy with automatic API key fallback, rate limiting, structured logging, and health monitoring. Supports OpenAI and Anthropic APIs with seamless format conversion and cross-provider routing.

**Warning:** This repo is under heavy development and is not yet ready for production use; be wary of inbound changed, frequent refactors, and more.

## Features

- **Multi-Provider Support**: Route requests to OpenAI or Anthropic based on model configuration
- **API Key Fallback**: Automatic failover to backup API keys when rate limits or errors occur
- **Circuit Breaker Pattern**: Failed keys enter cooldown period before retry
- **Format Conversion**: Seamless conversion between OpenAI and Anthropic API formats
- **Streaming Support**: Full Server-Sent Events (SSE) streaming for both providers
- **Structured Logging**: Comprehensive request/response logging to SQLite database
- **Rate Limiting**: Configurable per-client rate limits (requests and tokens per minute)
- **Health Checks**: Basic and detailed health monitoring endpoints
- **CORS Support**: Configurable Cross-Origin Resource Sharing
- **Error Handling**: Provider-standardized error responses matching OpenAI/Anthropic formats

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd centralized-inference-endpoint
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Set up environment variables (see [Configuration](#configuration) below)

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

Models are mapped to providers in `config/models.json`:

```json
{
  "gpt-4": {
    "provider": "openai",
    "provider_model": "gpt-4"
  },
  "claude-3-opus": {
    "provider": "anthropic",
    "provider_model": "claude-3-opus-20240229"
  }
}
```

## Running the Application

### Local Development

```bash
uvicorn app.main:app --reload --port 9876
```

The API will be available at `http://localhost:9876`

### Docker

Build the Docker image:
```bash
docker build -t centralized-inference-endpoint .
```

Run the container:
```bash
docker run -d -p 9876:9876 \
  -e CLIENT_API_KEY=your_client_key \
  -e OPENAI_API_KEY_1=your_openai_key \
  -e ANTHROPIC_API_KEY_1=your_anthropic_key \
  centralized-inference-endpoint
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
  "model": "gpt-4",
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
  "model": "claude-3-opus",
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

### Health Check Endpoints

#### GET `/health`
Basic health check. Returns 200 if database is accessible.

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
    "database": {"status": "healthy", "response_time_ms": 5},
    "providers": {
      "openai": {"status": "healthy", "keys_available": 2},
      "anthropic": {"status": "healthy", "keys_available": 1}
    },
    "model_config": {"status": "healthy", "models_count": 10},
    "provider_configs": {"status": "healthy", "providers_loaded": 2}
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

## Error Handling

Errors are returned in provider-standardized formats:

### OpenAI Format
```json
{
  "error": {
    "message": "Error description",
    "type": "error_type",
    "code": "error_code"
  }
}
```

### Anthropic Format
```json
{
  "error": {
    "message": "Error description",
    "type": "error_type"
  }
}
```

## Rate Limiting

Rate limiting is applied per client API key. Rate limit headers are included in responses:

- `X-RateLimit-Limit-Requests`: Maximum requests per minute
- `X-RateLimit-Remaining-Requests`: Remaining requests in current window
- `X-RateLimit-Limit-Tokens`: Maximum tokens per minute
- `X-RateLimit-Remaining-Tokens`: Remaining tokens in current window

When rate limit is exceeded, a `429` error is returned.

## Request Tracing

All requests include a unique `X-Request-ID` header in the response for tracing and debugging.

## Cross-Provider Routing

The system automatically routes requests to the appropriate provider based on the requested model:

- Requests for `gpt-*` models → OpenAI provider
- Requests for `claude-*` models → Anthropic provider

You can also route OpenAI requests to Anthropic models and vice versa - the system handles format conversion automatically.

## API Key Fallback

When a provider API call fails (4xx/5xx errors, timeouts), the system:

1. Marks the failed API key as unavailable
2. Automatically retries with the next available API key
3. Continues until all keys are exhausted or one succeeds
4. Failed keys enter a cooldown period (default: 5 minutes) before being retried

## Structured Logging

All requests and responses are logged to a SQLite database (`sql_app.db`) with:

- Request ID (UUID)
- Timestamp
- Endpoint and method
- Requested model and resolved provider/model
- Request parameters (temperature, max_tokens, etc.)
- Full message array
- Response status and timing
- Response content and usage statistics
- Error messages and types (if applicable)

Logs can be queried via the database or through future admin endpoints.

## Development

### Running Tests

```bash
pytest tests/ -v
```

### Code Structure

```
app/
├── main.py                 # FastAPI application entry point
├── auth.py                 # Client API key authentication
├── core/
│   ├── api_key_manager.py  # Provider API key management with fallback
│   ├── model_resolver.py  # Model-to-provider mapping
│   ├── format_converters.py # OpenAI ↔ Anthropic format conversion
│   ├── provider_config.py  # Provider configuration loader
│   ├── logging.py          # Logging utilities
│   ├── error_formatters.py # Error response formatters
│   └── startup_validation.py # Startup validation
├── providers/
│   ├── base.py            # Base provider interface
│   ├── openai_provider.py # OpenAI provider implementation
│   └── anthropic_provider.py # Anthropic provider implementation
├── routers/
│   ├── openai.py          # OpenAI-compatible endpoints
│   ├── anthropic.py       # Anthropic-compatible endpoints
│   └── health.py          # Health check endpoints
├── middleware/
│   ├── logging_middleware.py # Request ID and timing middleware
│   └── rate_limiting.py   # Rate limiting middleware
├── database/
│   ├── database.py        # Database connection
│   ├── models.py          # Legacy log models
│   ├── logging_models.py  # Structured logging models
│   ├── logging_crud.py    # Logging CRUD operations
│   └── crud.py            # Legacy CRUD operations
└── models/
    ├── openai.py          # OpenAI request/response models
    └── anthropic.py       # Anthropic request/response models
```

## Production Considerations

1. **Database**: Consider migrating from SQLite to PostgreSQL for production
2. **Rate Limiting**: Current implementation uses in-memory storage. Consider Redis for distributed deployments
3. **API Key Management**: Store API keys securely (secrets manager, environment variables)
4. **Monitoring**: Integrate with monitoring tools (Prometheus, Datadog, etc.)
5. **Scaling**: Use a process manager (systemd, supervisord) or container orchestration (Kubernetes)

## License

[Your License Here]

## Support

[Your Support Information Here]
