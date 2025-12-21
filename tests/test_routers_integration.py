"""
Integration tests for router endpoints.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def mock_openai_response():
    """Mock OpenAI API response."""
    return {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello, world!"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }


@pytest.fixture
def mock_anthropic_response():
    """Mock Anthropic API response."""
    return {
        "id": "msg_123",
        "type": "message",
        "role": "assistant",
        "model": "claude-4.5-opus",
        "content": [{"type": "text", "text": "Hello, world!"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 20},
    }


def test_openai_endpoint_with_auth(client, mock_env_vars, mock_openai_response):
    """Test OpenAI endpoint with valid authentication."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_openai_response

        response = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["model"] == "gpt-4"
        assert "choices" in data


def test_openai_endpoint_no_auth(client):
    """Test OpenAI endpoint without authentication."""
    response = client.post(
        "/v1/chat/completions",
        json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
    )

    assert response.status_code == 401


def test_openai_endpoint_invalid_auth(client):
    """Test OpenAI endpoint with invalid authentication."""
    response = client.post(
        "/v1/chat/completions",
        json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
        headers={"Authorization": "Bearer invalid_key"},
    )

    assert response.status_code == 401


def test_openai_endpoint_routes_to_anthropic(
    client, mock_env_vars, mock_anthropic_response
):
    """Test OpenAI endpoint routing to Anthropic provider."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.return_value = mock_anthropic_response

        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        # Should be converted to OpenAI format
        assert "choices" in data
        assert data["choices"][0]["message"]["content"] == "Hello, world!"


def test_anthropic_endpoint_with_auth(client, mock_env_vars, mock_anthropic_response):
    """Test Anthropic endpoint with valid authentication."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.return_value = mock_anthropic_response

        response = client.post(
            "/v1/messages",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["model"] == "claude-4.5-opus"
        assert "content" in data


def test_anthropic_endpoint_no_auth(client):
    """Test Anthropic endpoint without authentication."""
    response = client.post(
        "/v1/messages",
        json={
            "model": "claude-4.5-opus",
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 100,
        },
    )

    assert response.status_code == 401


def test_anthropic_endpoint_routes_to_openai(
    client, mock_env_vars, mock_openai_response
):
    """Test Anthropic endpoint routing to OpenAI provider."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_openai_response

        response = client.post(
            "/v1/messages",
            json={
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        # Should be converted to Anthropic format
        assert "content" in data
        assert data["content"][0]["text"] == "Hello, world!"


def test_openai_endpoint_invalid_model(client, mock_env_vars):
    """Test OpenAI endpoint with invalid model."""
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "invalid-model-xyz",
            "messages": [{"role": "user", "content": "Hello"}],
        },
        headers={"Authorization": "Bearer test_client_key_123"},
    )

    assert response.status_code == 400
    assert "not found" in response.json()["detail"].lower()


def test_openai_endpoint_streaming(client, mock_env_vars):
    """Test OpenAI streaming endpoint."""

    async def mock_stream():
        yield 'data: {"content": "chunk1"}\n'
        yield 'data: {"content": "chunk2"}\n'

    with patch(
        "app.providers.openai_provider.OpenAIProvider.call_stream"
    ) as mock_stream_func:
        mock_stream_func.return_value = mock_stream()

        response = client.post(
            "/v1/chat/completions-stream",
            json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]


def test_anthropic_endpoint_streaming(client, mock_env_vars):
    """Test Anthropic streaming endpoint."""

    async def mock_stream():
        yield "event: message_start\n"
        yield 'data: {"content": "chunk1"}\n'

    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call_stream"
    ) as mock_stream_func:
        mock_stream_func.return_value = mock_stream()

        response = client.post(
            "/v1/messages-stream",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]


def test_openai_endpoint_with_parameters(client, mock_env_vars, mock_openai_response):
    """Test OpenAI endpoint with various parameters."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_openai_response

        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "Hello"}],
                "temperature": 0.7,
                "top_p": 0.9,
                "max_tokens": 100,
                "presence_penalty": 0.1,
                "frequency_penalty": 0.2,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        # Verify parameters were passed
        call_kwargs = mock_call.call_args[1]
        assert call_kwargs["temperature"] == 0.7
        assert call_kwargs["top_p"] == 0.9
        assert call_kwargs["max_tokens"] == 100


def test_anthropic_endpoint_with_parameters(
    client, mock_env_vars, mock_anthropic_response
):
    """Test Anthropic endpoint with various parameters."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.return_value = mock_anthropic_response

        response = client.post(
            "/v1/messages",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
                "temperature": 0.7,
                "top_p": 0.9,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        # Verify parameters were passed
        call_kwargs = mock_call.call_args[1]
        assert call_kwargs["max_tokens"] == 100
        # Temperature and top_p might be None if not explicitly set
        if "temperature" in call_kwargs and call_kwargs["temperature"] is not None:
            assert call_kwargs["temperature"] == 0.7
        if "top_p" in call_kwargs and call_kwargs["top_p"] is not None:
            assert call_kwargs["top_p"] == 0.9


def test_openai_endpoint_error_handling(client, mock_env_vars):
    """Test OpenAI endpoint error handling."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.side_effect = Exception("API error occurred")

        response = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 500
        assert "error" in response.json()["detail"].lower()


def test_cross_provider_routing_openai_to_anthropic(
    client, mock_env_vars, mock_anthropic_response
):
    """Test routing OpenAI model request through Anthropic endpoint."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_openai_resp = {
            "id": "chatcmpl-123",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-4",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        }
        mock_call.return_value = mock_openai_resp

        response = client.post(
            "/v1/messages",
            json={
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        # Should be in Anthropic format
        assert "content" in data
        assert data["content"][0]["text"] == "Hello"


def test_cross_provider_routing_anthropic_to_openai(
    client, mock_env_vars, mock_openai_response
):
    """Test routing Anthropic model request through OpenAI endpoint."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_anthropic_resp = {
            "id": "msg_123",
            "type": "message",
            "role": "assistant",
            "model": "claude-4.5-opus-20240229",
            "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }
        mock_call.return_value = mock_anthropic_resp

        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        # Should be in OpenAI format
        assert "choices" in data
        assert data["choices"][0]["message"]["content"] == "Hello"
