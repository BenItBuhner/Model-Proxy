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


def test_chat_completions_no_tools(client: TestClient, mock_env_vars):
    """
    Tests the /v1/chat/completions endpoint for a standard request without tools.
    """
    mock_response = {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello there!"},
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
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello!"}],
        }
        response = client.post(
            "/v1/chat/completions",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        response_json = response.json()

        assert response_json["model"] == "gpt-4"
        assert response_json["choices"][0]["message"]["role"] == "assistant"
        assert "content" in response_json["choices"][0]["message"]
        assert response_json["choices"][0]["finish_reason"] == "stop"
        assert "tool_calls" not in response_json["choices"][0]["message"]


def test_chat_completions_with_tools_are_ignored(client: TestClient, mock_env_vars):
    """
    Tests that the /v1/chat/completions endpoint handles the 'tools' parameter.
    """
    mock_response = {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "The answer is 3"},
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
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "What is 1 + 2?"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "add",
                        "description": "Adds two numbers",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "a": {"type": "number"},
                                "b": {"type": "number"},
                            },
                            "required": ["a", "b"],
                        },
                    },
                }
            ],
        }

        response = client.post(
            "/v1/chat/completions",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        response_json = response.json()

        # Assert that we get a standard response
        assert response_json["model"] == "gpt-4"
        assert response_json["choices"][0]["message"]["role"] == "assistant"
        assert "content" in response_json["choices"][0]["message"]
        assert response_json["choices"][0]["finish_reason"] == "stop"


def test_chat_completions_stream(client: TestClient, mock_env_vars):
    """
    Tests the /v1/chat/completions-stream endpoint.
    """

    async def mock_stream():
        yield 'data: {"content": "chunk1"}\n'
        yield 'data: {"content": "chunk2"}\n'

    with patch(
        "app.providers.openai_provider.OpenAIProvider.call_stream"
    ) as mock_stream_func:
        mock_stream_func.return_value = mock_stream()

        request_data = {
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello!"}],
            "stream": True,
        }

        response = client.post(
            "/v1/chat/completions-stream",
            json=request_data,
            headers={"Authorization": "Bearer test_client_key_123"},
        )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Check that we receive streaming content
        content = response.text
        assert len(content) > 0


def test_list_models(client: TestClient, mock_env_vars):
    """
    Test the /v1/models endpoint to list available models.
    """
    response = client.get(
        "/v1/models", headers={"Authorization": "Bearer test_client_key_123"}
    )

    assert response.status_code == 200

    data = response.json()
    assert data["object"] == "list"
    assert "data" in data
    assert isinstance(data["data"], list)

    # Should have all configured models
    model_ids = [model["id"] for model in data["data"]]
    expected_models = [
        "gpt-4",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
        "claude-4.5-opus",
        "claude-4.5-sonnet",
        "claude-4.5-haiku",
        "cerebras-llama-3.1-70b",
        "groq-llama-3.1-70b",
        "github-deepseek-r1",
        "azure-gpt-4",
    ]

    # Check that some expected models are present
    for expected_model in expected_models:
        assert expected_model in model_ids

    # Verify model structure
    for model in data["data"]:
        assert "id" in model
        assert "object" in model
        assert "created" in model
        assert "owned_by" in model
        assert model["object"] == "model"
