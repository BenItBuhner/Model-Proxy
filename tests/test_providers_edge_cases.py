"""
Comprehensive tests for provider implementations with advanced scenarios.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.core.api_key_manager import mark_key_failed, reset_failed_keys
from app.providers.anthropic_provider import AnthropicProvider
from app.providers.openai_provider import OpenAIProvider


@pytest.fixture(autouse=True)
def reset_keys():
    """Reset failed keys before each test."""
    reset_failed_keys()
    yield
    reset_failed_keys()


@pytest.mark.asyncio
async def test_openai_provider_timeout_retry(monkeypatch):
    """Test OpenAI provider retries on timeout."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    provider = OpenAIProvider()

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "id": "chatcmpl-123",
        "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(
            side_effect=[httpx.TimeoutException("Timeout"), mock_response]
        )
        mock_client.return_value = mock_client_instance

        result = await provider.call(
            model="gpt-4", messages=[{"role": "user", "content": "Hello"}]
        )

        assert result["choices"][0]["message"]["content"] == "Hello"
        assert mock_client_instance.post.call_count == 2


@pytest.mark.asyncio
async def test_openai_provider_429_retry(monkeypatch):
    """Test OpenAI provider retries on 429 rate limit."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    provider = OpenAIProvider()

    mock_response_fail = MagicMock()
    mock_response_fail.status_code = 429
    mock_response_fail.text = "Rate limit exceeded"

    mock_response_success = MagicMock()
    mock_response_success.status_code = 200
    mock_response_success.json.return_value = {
        "id": "chatcmpl-123",
        "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(
            side_effect=[mock_response_fail, mock_response_success]
        )
        mock_client.return_value = mock_client_instance

        result = await provider.call(
            model="gpt-4", messages=[{"role": "user", "content": "Hello"}]
        )

        assert result["choices"][0]["message"]["content"] == "Hello"
        # Verify retry happened
        assert mock_client_instance.post.call_count == 2


@pytest.mark.asyncio
async def test_openai_provider_500_retry(monkeypatch):
    """Test OpenAI provider retries on 500 error."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    provider = OpenAIProvider()

    mock_response_fail = MagicMock()
    mock_response_fail.status_code = 500
    mock_response_fail.text = "Internal server error"

    mock_response_success = MagicMock()
    mock_response_success.status_code = 200
    mock_response_success.json.return_value = {
        "id": "chatcmpl-123",
        "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(
            side_effect=[mock_response_fail, mock_response_success]
        )
        mock_client.return_value = mock_client_instance

        result = await provider.call(
            model="gpt-4", messages=[{"role": "user", "content": "Hello"}]
        )

        assert result["choices"][0]["message"]["content"] == "Hello"


@pytest.mark.asyncio
async def test_openai_provider_stream_error_retry(monkeypatch):
    """Test OpenAI provider streaming retries on error."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    provider = OpenAIProvider()

    async def mock_iter_lines_success():
        yield 'data: {"content": "chunk1"}\n'
        yield 'data: {"content": "chunk2"}\n'

    mock_stream_fail = AsyncMock()
    mock_stream_fail.__aenter__.return_value = mock_stream_fail
    mock_stream_fail.__aexit__.return_value = None
    mock_stream_fail.status_code = 429
    mock_stream_fail.aread = AsyncMock(return_value=b"Rate limit")

    mock_stream_success = AsyncMock()
    mock_stream_success.__aenter__.return_value = mock_stream_success
    mock_stream_success.__aexit__.return_value = None
    mock_stream_success.status_code = 200
    mock_stream_success.aiter_lines = mock_iter_lines_success

    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=None)
    mock_client_instance.stream = MagicMock(
        side_effect=[mock_stream_fail, mock_stream_success]
    )

    with patch("httpx.AsyncClient", return_value=mock_client_instance):
        chunks = []
        async for chunk in provider.call_stream(
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        ):
            chunks.append(chunk)

        assert len(chunks) > 0


@pytest.mark.asyncio
async def test_anthropic_provider_401_retry(monkeypatch):
    """Test Anthropic provider retries on 401 unauthorized."""
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "key1")
    monkeypatch.setenv("ANTHROPIC_API_KEY_2", "key2")

    provider = AnthropicProvider()

    mock_response_fail = MagicMock()
    mock_response_fail.status_code = 401
    mock_response_fail.text = "Invalid API key"

    mock_response_success = MagicMock()
    mock_response_success.status_code = 200
    mock_response_success.json.return_value = {
        "id": "msg_123",
        "content": [{"type": "text", "text": "Hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 20},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(
            side_effect=[mock_response_fail, mock_response_success]
        )
        mock_client.return_value = mock_client_instance

        result = await provider.call(
            model="claude-4.5-opus",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )

        assert result["content"][0]["text"] == "Hello"


@pytest.mark.asyncio
async def test_anthropic_provider_stream_timeout(monkeypatch):
    """Test Anthropic provider streaming handles timeout."""
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "key1")
    monkeypatch.setenv("ANTHROPIC_API_KEY_2", "key2")

    provider = AnthropicProvider()

    async def mock_iter_lines():
        yield "event: message_start\n"
        yield 'data: {"content": "chunk"}\n'

    mock_stream_fail = AsyncMock()
    mock_stream_fail.__aenter__ = AsyncMock(
        side_effect=httpx.TimeoutException("Timeout")
    )

    mock_stream_success = AsyncMock()
    mock_stream_success.__aenter__ = AsyncMock(return_value=mock_stream_success)
    mock_stream_success.__aexit__ = AsyncMock(return_value=None)
    mock_stream_success.status_code = 200
    mock_stream_success.aiter_lines = mock_iter_lines

    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=None)
    mock_client_instance.stream = MagicMock(
        side_effect=[mock_stream_fail, mock_stream_success]
    )

    with patch("httpx.AsyncClient", return_value=mock_client_instance):
        chunks = []
        async for chunk in provider.call_stream(
            model="claude-4.5-opus",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        ):
            chunks.append(chunk)

        assert len(chunks) > 0


@pytest.mark.asyncio
async def test_openai_provider_all_keys_exhausted(monkeypatch):
    """Test OpenAI provider when all keys are exhausted."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    provider = OpenAIProvider()

    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.text = "Invalid API key"

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(return_value=mock_response)
        mock_client.return_value = mock_client_instance

        with pytest.raises(Exception):
            await provider.call(
                model="gpt-4", messages=[{"role": "user", "content": "Hello"}]
            )


@pytest.mark.asyncio
async def test_openai_provider_parameters_passed(monkeypatch):
    """Test that all OpenAI parameters are passed correctly."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    provider = OpenAIProvider()

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "id": "chatcmpl-123",
        "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(return_value=mock_response)
        mock_client.return_value = mock_client_instance

        await provider.call(
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}],
            temperature=0.7,
            top_p=0.9,
            max_tokens=100,
            presence_penalty=0.1,
            frequency_penalty=0.2,
            stop=["STOP"],
            logit_bias={"123": 0.5},
            user="test_user",
            tools=[{"type": "function", "function": {"name": "test"}}],
            tool_choice="auto",
        )

        call_args = mock_client_instance.post.call_args
        payload = call_args[1]["json"]

        assert payload["temperature"] == 0.7
        assert payload["top_p"] == 0.9
        assert payload["max_tokens"] == 100
        assert payload["presence_penalty"] == 0.1
        assert payload["frequency_penalty"] == 0.2
        assert payload["stop"] == ["STOP"]
        assert payload["logit_bias"] == {"123": 0.5}
        assert payload["user"] == "test_user"
        assert payload["tools"] == [{"type": "function", "function": {"name": "test"}}]
        assert payload["tool_choice"] == "auto"


@pytest.mark.asyncio
async def test_anthropic_provider_parameters_passed(monkeypatch):
    """Test that all Anthropic parameters are passed correctly."""
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "key1")

    provider = AnthropicProvider()

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "id": "msg_123",
        "content": [{"type": "text", "text": "Hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 20},
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client_instance = AsyncMock()
        mock_client_instance.__aenter__.return_value = mock_client_instance
        mock_client_instance.__aexit__.return_value = None
        mock_client_instance.post = AsyncMock(return_value=mock_response)
        mock_client.return_value = mock_client_instance

        await provider.call(
            model="claude-4.5-opus",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
            temperature=0.7,
            top_p=0.9,
            top_k=40,
            tools=[{"name": "test", "description": "test", "input_schema": {}}],
        )

        call_args = mock_client_instance.post.call_args
        payload = call_args[1]["json"]

        assert payload["max_tokens"] == 100
        assert payload["temperature"] == 0.7
        assert payload["top_p"] == 0.9
        assert payload["top_k"] == 40
        assert len(payload["tools"]) == 1
