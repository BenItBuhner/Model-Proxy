"""
Comprehensive integration tests for router endpoints with advanced scenarios.
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


def test_openai_endpoint_with_all_parameters(
    client, mock_env_vars, mock_openai_response
):
    """Test OpenAI endpoint with all possible parameters."""
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
                "n": 1,
                "stream": False,
                "stop": ["STOP"],
                "max_tokens": 100,
                "presence_penalty": 0.1,
                "frequency_penalty": 0.2,
                "logit_bias": {"123": 0.5},
                "user": "test_user",
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "description": "Get weather",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
                "tool_choice": "auto",
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["model"] == "gpt-4"


def test_anthropic_endpoint_with_all_parameters(
    client, mock_env_vars, mock_anthropic_response
):
    """Test Anthropic endpoint with all possible parameters."""
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
                "stream": False,
                "temperature": 0.7,
                "top_p": 0.9,
                "top_k": 40,
                "tools": [
                    {
                        "name": "get_weather",
                        "description": "Get weather",
                        "input_schema": {"type": "object"},
                    }
                ],
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["model"] == "claude-4.5-opus"


def test_openai_endpoint_multiple_messages(client, mock_env_vars, mock_openai_response):
    """Test OpenAI endpoint with multiple messages."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_openai_response

        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "gpt-4",
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Hello"},
                    {"role": "assistant", "content": "Hi there!"},
                    {"role": "user", "content": "How are you?"},
                ],
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        call_args = mock_call.call_args
        assert len(call_args[1]["messages"]) == 4


def test_anthropic_endpoint_multiple_messages(
    client, mock_env_vars, mock_anthropic_response
):
    """Test Anthropic endpoint with multiple messages."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.return_value = mock_anthropic_response

        response = client.post(
            "/v1/messages",
            json={
                "model": "claude-4.5-opus",
                "messages": [
                    {"role": "user", "content": "Hello"},
                    {"role": "assistant", "content": "Hi there!"},
                    {"role": "user", "content": "How are you?"},
                ],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        call_args = mock_call.call_args
        assert len(call_args[1]["messages"]) == 3


def test_openai_endpoint_streaming_chunks(client, mock_env_vars):
    """Test OpenAI streaming endpoint returns chunks."""

    async def mock_stream():
        yield 'data: {"id": "chatcmpl-123", "choices": [{"delta": {"content": "Hello"}}]}\n'
        yield 'data: {"id": "chatcmpl-123", "choices": [{"delta": {"content": " World"}}]}\n'
        yield "data: [DONE]\n"

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
        content = response.text
        assert "Hello" in content
        assert "World" in content


def test_anthropic_endpoint_streaming_chunks(client, mock_env_vars):
    """Test Anthropic streaming endpoint returns chunks."""

    async def mock_stream():
        yield "event: message_start\n"
        yield 'data: {"type": "content_block_delta", "delta": {"text": "Hello"}}\n'
        yield 'data: {"type": "content_block_delta", "delta": {"text": " World"}}\n'
        yield "event: message_stop\n"

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
        content = response.text
        assert len(content) > 0


def test_openai_endpoint_provider_error_propagation(client, mock_env_vars):
    """Test that provider errors are properly handled."""
    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.side_effect = Exception("No API keys available")

        response = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 500
        error_detail = response.json()["detail"]
        # Error format is now standardized - check if it's a dict with "error" key
        if isinstance(error_detail, dict) and "error" in error_detail:
            assert "error" in error_detail
            assert "message" in error_detail["error"]
        else:
            # Fallback for string format
            assert "error" in str(error_detail).lower()


def test_anthropic_endpoint_provider_error_propagation(client, mock_env_vars):
    """Test that provider errors are properly handled."""
    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.side_effect = Exception("No API keys available")

        response = client.post(
            "/v1/messages",
            json={
                "model": "claude-4.5-opus",
                "messages": [{"role": "user", "content": "Hello"}],
                "max_tokens": 100,
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 500
        error_detail = response.json()["detail"]
        # Error format is now standardized - check if it's a dict with "error" key
        if isinstance(error_detail, dict) and "error" in error_detail:
            assert "error" in error_detail
            assert "message" in error_detail["error"]
        else:
            # Fallback for string format
            assert "error" in str(error_detail).lower()


def test_openai_endpoint_cross_provider_tool_conversion(
    client, mock_env_vars, mock_anthropic_response
):
    """Test OpenAI endpoint routing to Anthropic with tools."""
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
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "description": "Get weather",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        # Verify tools were converted
        call_args = mock_call.call_args
        assert "tools" in call_args[1] or "tools" in call_args[0][2]


def test_anthropic_endpoint_cross_provider_tool_conversion(
    client, mock_env_vars, mock_openai_response
):
    """Test Anthropic endpoint routing to OpenAI with tools."""
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
                "tools": [
                    {
                        "name": "get_weather",
                        "description": "Get weather",
                        "input_schema": {"type": "object"},
                    }
                ],
            },
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        # Verify tools were converted
        call_args = mock_call.call_args
        assert "tools" in call_args[1] or "tools" in call_args[0][2]


def test_openai_endpoint_model_name_preserved(
    client, mock_env_vars, mock_openai_response
):
    """Test that requested model name is preserved in response."""
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
        assert data["model"] == "gpt-4"  # Should preserve requested model name


def test_anthropic_endpoint_model_name_preserved(
    client, mock_env_vars, mock_anthropic_response
):
    """Test that requested model name is preserved in response."""
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
        assert (
            data["model"] == "claude-4.5-opus"
        )  # Should preserve requested model name


def test_openai_endpoint_empty_response_handling(client, mock_env_vars):
    """Test OpenAI endpoint handles empty responses."""
    empty_response = {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": ""},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
    }

    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = empty_response

        response = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]},
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["choices"][0]["message"]["content"] == ""


def test_anthropic_endpoint_empty_response_handling(client, mock_env_vars):
    """Test Anthropic endpoint handles empty responses."""
    empty_response = {
        "id": "msg_123",
        "type": "message",
        "role": "assistant",
        "model": "claude-4.5-opus",
        "content": [],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 0},
    }

    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call",
        new_callable=AsyncMock,
    ) as mock_call:
        mock_call.return_value = empty_response

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
        assert len(data["content"]) == 0
