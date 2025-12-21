import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# The client fixture is defined in conftest.py and is automatically available.


@pytest.fixture(autouse=True)
def mock_env_vars(monkeypatch):
    """Mock environment variables for testing."""
    monkeypatch.setenv("CLIENT_API_KEY", "test_client_key_123")
    monkeypatch.setenv("OPENAI_API_KEY_1", "test_openai_key_1")
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "test_anthropic_key_1")


def test_anthropic_messages_no_tools(client: TestClient, mock_env_vars):
    """
    Tests the /v1/messages endpoint for a standard request without tools.
    """
    # Mock OpenAI-compatible response (since groq/kimi-k2 routes to Groq which is OpenAI-compatible)
    mock_response = {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "moonshotai/kimi-k2-instruct-0905",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello!"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_response

        request_data = {
            "model": "groq/kimi-k2",
            "messages": [{"role": "user", "content": "Hello!"}],
            "max_tokens": 1024,
        }
        response = client.post(
            "/v1/messages",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        response_json = response.json()

        assert response_json["model"] == "groq/kimi-k2"
        assert response_json["role"] == "assistant"
        assert response_json["stop_reason"] == "end_turn"

        content = response_json["content"]
        assert len(content) == 1
        assert content[0]["type"] == "text"
        assert "text" in content[0]


def test_anthropic_messages_with_tools_are_ignored(client: TestClient, mock_env_vars):
    """
    Tests that the /v1/messages endpoint handles the 'tools' parameter.
    """
    # Mock OpenAI-compatible response
    mock_response = {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "moonshotai/kimi-k2-instruct-0905",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello!"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch(
        "app.providers.openai_provider.OpenAIProvider.call", new_callable=AsyncMock
    ) as mock_call:
        mock_call.return_value = mock_response

        request_data = {
            "model": "groq/kimi-k2",
            "messages": [{"role": "user", "content": "Hello!"}],
            "max_tokens": 1024,
            "tools": [
                {
                    "name": "get_weather",
                    "description": "Get the current weather in a given location",
                    "input_schema": {
                        "type": "object",
                        "properties": {"location": {"type": "string"}},
                    },
                }
            ],
        }
        response = client.post(
            "/v1/messages",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        response_json = response.json()

        assert response_json["stop_reason"] == "end_turn"
        content = response_json["content"]
        assert len(content) == 1
        assert content[0]["type"] == "text"


def test_anthropic_messages_stream(client: TestClient, mock_env_vars):
    """
    Tests the /v1/messages-stream endpoint.
    """

    async def mock_stream():
        yield "event: message_start\n"
        yield 'data: {"content": "chunk1"}\n'

    with patch(
        "app.providers.anthropic_provider.AnthropicProvider.call_stream"
    ) as mock_stream_func:
        mock_stream_func.return_value = mock_stream()

        request_data = {
            "model": "claude-4.5-opus",
            "messages": [{"role": "user", "content": "Hello!"}],
            "max_tokens": 1024,
            "stream": True,
        }

        response = client.post(
            "/v1/messages-stream",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Check that we receive streaming content
        content = response.text
        assert len(content) > 0
