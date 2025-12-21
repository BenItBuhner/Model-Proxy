"""
Comprehensive tests for the new fallback routing system.
Tests the RouteExecutor, ProviderRegistry, and FallbackRouter integration.
"""

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.providers.base import BaseProvider
from app.providers.registry import (
    ProviderRegistry,
    get_available_providers,
    get_provider,
    is_valid_provider,
)
from app.routing.executor import RouteExecutionError, RouteExecutor, get_executor
from app.routing.models import (
    Attempt,
    ModelRoutingConfig,
    ResolvedRoute,
    RouteConfig,
    RoutingError,
)
from app.routing.router import FallbackRouter, call_with_fallback


class TestProviderRegistry:
    """Test the provider registry functionality."""

    def test_get_available_providers(self):
        """Test getting list of available providers."""
        providers = get_available_providers()

        assert isinstance(providers, list)
        assert len(providers) > 0
        assert "openai" in providers
        assert "anthropic" in providers
        assert "nahcrof" in providers
        assert "cerebras" in providers

    def test_is_valid_provider(self):
        """Test checking if a provider is valid."""
        assert is_valid_provider("openai") is True
        assert is_valid_provider("anthropic") is True
        assert is_valid_provider("nahcrof") is True
        assert is_valid_provider("nonexistent") is False
        assert is_valid_provider("") is False

    def test_get_provider_class(self):
        """Test getting provider class by name."""
        from app.providers.anthropic_provider import AnthropicProvider
        from app.providers.azure_provider import AzureProvider
        from app.providers.openai_provider import OpenAIProvider

        assert ProviderRegistry.get_provider_class("openai") == OpenAIProvider
        assert ProviderRegistry.get_provider_class("nahcrof") == OpenAIProvider
        assert ProviderRegistry.get_provider_class("anthropic") == AnthropicProvider
        assert ProviderRegistry.get_provider_class("github") == AzureProvider

    def test_get_provider_class_unknown(self):
        """Test getting unknown provider class raises error."""
        with pytest.raises(ValueError) as exc_info:
            ProviderRegistry.get_provider_class("unknown_provider")

        assert "unknown_provider" in str(exc_info.value).lower()
        assert "available providers" in str(exc_info.value).lower()

    @patch("app.providers.openai_provider.get_provider_config")
    def test_create_provider_with_route_config(self, mock_config):
        """Test creating a provider with route configuration."""
        mock_config.return_value = {
            "endpoints": {
                "base_url": "https://api.test.com",
                "completions": "/v1/chat",
            },
            "proxy_support": {"enabled": False},
            "request_config": {"timeout_seconds": 60},
        }

        provider = ProviderRegistry.create_provider(
            provider_name="openai",
            api_key="test-api-key",
            base_url="https://custom.url.com",
        )

        assert provider is not None
        assert provider._route_api_key == "test-api-key"
        assert provider._route_base_url == "https://custom.url.com"

    def test_register_custom_provider(self):
        """Test registering a custom provider."""

        class CustomProvider(BaseProvider):
            async def call(self, model, messages, **kwargs):
                return {}

            async def call_stream(self, model, messages, **kwargs):
                yield ""

        ProviderRegistry.register_provider("custom_test", CustomProvider)

        assert is_valid_provider("custom_test") is True
        assert ProviderRegistry.get_provider_class("custom_test") == CustomProvider

        # Cleanup
        ProviderRegistry.unregister_provider("custom_test")
        assert is_valid_provider("custom_test") is False

    def test_unregister_provider(self):
        """Test unregistering a provider."""

        class TempProvider(BaseProvider):
            async def call(self, model, messages, **kwargs):
                return {}

            async def call_stream(self, model, messages, **kwargs):
                yield ""

        ProviderRegistry.register_provider("temp_provider", TempProvider)
        assert is_valid_provider("temp_provider") is True

        result = ProviderRegistry.unregister_provider("temp_provider")
        assert result is True
        assert is_valid_provider("temp_provider") is False

        # Try to unregister again
        result = ProviderRegistry.unregister_provider("temp_provider")
        assert result is False


class TestRouteExecutor:
    """Test the RouteExecutor class."""

    @pytest.fixture
    def executor(self):
        """Create a RouteExecutor instance."""
        return RouteExecutor()

    @pytest.fixture
    def sample_route(self):
        """Create a sample resolved route."""
        return ResolvedRoute(
            source_logical_model="test-model",
            wire_protocol="openai",
            provider="openai",
            model="gpt-4",
            api_key="test-key",
            timeout_seconds=60,
        )

    @pytest.fixture
    def sample_anthropic_route(self):
        """Create a sample Anthropic resolved route."""
        return ResolvedRoute(
            source_logical_model="test-model",
            wire_protocol="anthropic",
            provider="anthropic",
            model="claude-4.5-opus",
            api_key="test-key",
            timeout_seconds=60,
        )

    def test_executor_singleton(self):
        """Test that get_executor returns a singleton."""
        executor1 = get_executor()
        executor2 = get_executor()
        assert executor1 is executor2

    def test_convert_request_same_protocol(self, executor):
        """Test that request conversion is a no-op for same protocols."""
        request = {"model": "test", "messages": [{"role": "user", "content": "Hello"}]}

        result = executor._convert_request(request, "openai", "openai")
        assert result == request

        result = executor._convert_request(request, "anthropic", "anthropic")
        assert result == request

    @patch("app.routing.executor.anthropic_to_openai_request")
    def test_convert_request_anthropic_to_openai(self, mock_convert, executor):
        """Test request conversion from Anthropic to OpenAI format."""
        request = {
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 100,
        }
        mock_convert.return_value = {"messages": [{"role": "user", "content": "Hello"}]}

        executor._convert_request(request, "anthropic", "openai")

        mock_convert.assert_called_once_with(request)

    @patch("app.routing.executor.openai_to_anthropic_request")
    def test_convert_request_openai_to_anthropic(self, mock_convert, executor):
        """Test request conversion from OpenAI to Anthropic format."""
        request = {
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 100,
        }
        mock_convert.return_value = {"messages": [{"role": "user", "content": "Hello"}]}

        executor._convert_request(request, "openai", "anthropic")

        mock_convert.assert_called_once_with(request)

    @patch("app.routing.executor.openai_to_anthropic_response")
    def test_convert_response_openai_to_anthropic(self, mock_convert, executor):
        """Test response conversion from OpenAI to Anthropic format."""
        response = {"choices": [{"message": {"content": "Hello"}}]}
        mock_convert.return_value = {"content": [{"text": "Hello"}]}

        executor._convert_response(response, "openai", "anthropic", "test-model")

        mock_convert.assert_called_once_with(response, "test-model")

    @patch("app.routing.executor.anthropic_to_openai_response")
    def test_convert_response_anthropic_to_openai(self, mock_convert, executor):
        """Test response conversion from Anthropic to OpenAI format."""
        response = {"content": [{"text": "Hello"}]}
        mock_convert.return_value = {"choices": [{"message": {"content": "Hello"}}]}

        executor._convert_response(response, "anthropic", "openai", "test-model")

        mock_convert.assert_called_once_with(response, "test-model")

    @pytest.mark.asyncio
    @patch("app.routing.executor.ProviderRegistry.get_provider_for_route")
    async def test_execute_openai_route(
        self, mock_get_provider, executor, sample_route
    ):
        """Test executing an OpenAI route."""
        mock_provider = Mock()
        mock_provider.call = AsyncMock(
            return_value={
                "choices": [{"message": {"content": "Hello"}}],
                "model": "gpt-4",
            }
        )
        mock_get_provider.return_value = mock_provider

        request_data = {
            "model": "test-model",
            "messages": [{"role": "user", "content": "Hello"}],
        }

        result = await executor.execute(
            route=sample_route, request_data=request_data, target_protocol="openai"
        )

        assert "choices" in result
        mock_provider.call.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.routing.executor.ProviderRegistry.get_provider_for_route")
    async def test_execute_with_protocol_conversion(
        self, mock_get_provider, executor, sample_route
    ):
        """Test executing a route with protocol conversion."""
        mock_provider = Mock()
        mock_provider.call = AsyncMock(
            return_value={
                "choices": [{"message": {"content": "Hello"}}],
                "model": "gpt-4",
            }
        )
        mock_get_provider.return_value = mock_provider

        # Client sends Anthropic format, route is OpenAI
        request_data = {
            "model": "test-model",
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 100,
        }

        with patch(
            "app.routing.executor.anthropic_to_openai_request"
        ) as mock_convert_req:
            mock_convert_req.return_value = request_data
            with patch(
                "app.routing.executor.openai_to_anthropic_response"
            ) as mock_convert_resp:
                mock_convert_resp.return_value = {"content": [{"text": "Hello"}]}

                result = await executor.execute(
                    route=sample_route,
                    request_data=request_data,
                    target_protocol="anthropic",  # Client expects Anthropic
                )

                assert "content" in result
                mock_convert_req.assert_called_once()
                mock_convert_resp.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.routing.executor.ProviderRegistry.get_provider_for_route")
    async def test_execute_raises_route_execution_error(
        self, mock_get_provider, executor, sample_route
    ):
        """Test that execution errors are wrapped in RouteExecutionError."""
        mock_provider = Mock()
        mock_provider.call = AsyncMock(side_effect=Exception("API Error"))
        mock_get_provider.return_value = mock_provider

        request_data = {"messages": [{"role": "user", "content": "Hello"}]}

        with pytest.raises(RouteExecutionError) as exc_info:
            await executor.execute(
                route=sample_route, request_data=request_data, target_protocol="openai"
            )

        assert sample_route.provider in str(exc_info.value)
        assert exc_info.value.route == sample_route

    @pytest.mark.asyncio
    @patch("app.routing.executor.ProviderRegistry.get_provider_for_route")
    async def test_execute_stream(self, mock_get_provider, executor, sample_route):
        """Test executing a streaming route."""
        mock_provider = Mock()

        async def mock_stream(*args, **kwargs):
            yield "data: chunk1\n\n"
            yield "data: chunk2\n\n"
            yield "data: [DONE]\n\n"

        mock_provider.call_stream = mock_stream
        mock_get_provider.return_value = mock_provider

        request_data = {"messages": [{"role": "user", "content": "Hello"}]}

        chunks = []
        async for chunk in executor.execute_stream(
            route=sample_route, request_data=request_data, target_protocol="openai"
        ):
            chunks.append(chunk)

        assert len(chunks) == 3


class TestRouteExecutionError:
    """Test the RouteExecutionError class."""

    def test_error_creation(self):
        """Test creating a RouteExecutionError."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )

        error = RouteExecutionError(
            message="Test error", route=route, original_error=ValueError("Original")
        )

        assert "Test error" in str(error)
        assert error.route == route
        assert isinstance(error.original_error, ValueError)

    def test_error_with_status_code(self):
        """Test RouteExecutionError with status code."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )

        error = RouteExecutionError(message="HTTP Error", route=route, status_code=500)

        assert error.status == 500

    def test_error_propagates_status_from_original(self):
        """Test that status is propagated from original error."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )

        original = Exception("API Error")
        original.status = 429

        error = RouteExecutionError(
            message="Rate limited", route=route, original_error=original
        )

        assert error.status == 429


class TestFallbackRouterIntegration:
    """Integration tests for the FallbackRouter with RouteExecutor."""

    @pytest.fixture
    def mock_config_loader(self):
        """Mock config loader with test configurations."""
        with patch("app.routing.router.config_loader") as mock_loader:
            config = ModelRoutingConfig(
                logical_name="test-model",
                timeout_seconds=60,
                model_routings=[
                    RouteConfig(
                        id="primary",
                        wire_protocol="openai",
                        provider="provider-a",
                        model="model-a",
                        api_key_env=["KEY_A"],
                    ),
                    RouteConfig(
                        id="secondary",
                        wire_protocol="openai",
                        provider="provider-b",
                        model="model-b",
                        api_key_env=["KEY_B"],
                    ),
                ],
                fallback_model_routings=[],
            )

            mock_loader.load_config.return_value = config
            yield mock_loader

    @pytest.fixture
    def mock_executor(self):
        """Mock route executor."""
        executor = Mock(spec=RouteExecutor)
        executor.execute = AsyncMock()
        executor.execute_stream = AsyncMock()
        return executor

    @pytest.mark.asyncio
    async def test_successful_first_attempt(self, mock_config_loader, mock_executor):
        """Test successful call on first attempt."""
        mock_executor.execute.return_value = {"success": True}

        router = FallbackRouter(executor=mock_executor)

        with patch.dict(os.environ, {"KEY_A": "key_a", "KEY_B": "key_b"}):
            result = await router.call_with_fallback(
                logical_model="test-model",
                request_data={"messages": [{"role": "user", "content": "Hi"}]},
                target_protocol="openai",
            )

        assert result["success"] is True
        assert mock_executor.execute.call_count == 1

    @pytest.mark.asyncio
    async def test_fallback_on_first_failure(self, mock_config_loader, mock_executor):
        """Test fallback when first attempt fails."""

        call_count = 0

        async def mock_execute(route, request_data, target_protocol):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RouteExecutionError(
                    message="First failed", route=route, status_code=500
                )
            return {"success": True, "provider": route.provider}

        mock_executor.execute.side_effect = mock_execute

        router = FallbackRouter(executor=mock_executor)

        with patch.dict(os.environ, {"KEY_A": "key_a", "KEY_B": "key_b"}):
            result = await router.call_with_fallback(
                logical_model="test-model",
                request_data={"messages": [{"role": "user", "content": "Hi"}]},
                target_protocol="openai",
            )

        assert result["success"] is True
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_all_attempts_fail(self, mock_config_loader, mock_executor):
        """Test RoutingError when all attempts fail."""

        async def mock_execute(route, request_data, target_protocol):
            raise RouteExecutionError(
                message=f"Failed: {route.provider}", route=route, status_code=500
            )

        mock_executor.execute.side_effect = mock_execute

        router = FallbackRouter(executor=mock_executor)

        with patch.dict(os.environ, {"KEY_A": "key_a", "KEY_B": "key_b"}):
            with pytest.raises(RoutingError) as exc_info:
                await router.call_with_fallback(
                    logical_model="test-model",
                    request_data={"messages": [{"role": "user", "content": "Hi"}]},
                    target_protocol="openai",
                )

        error = exc_info.value
        assert error.logical_model == "test-model"
        assert len(error.errors) == 2
        assert len(error.attempted_routes) == 2

    @pytest.mark.asyncio
    async def test_no_routes_available(self, mock_config_loader, mock_executor):
        """Test RoutingError when no routes are available (no API keys)."""
        router = FallbackRouter(executor=mock_executor)

        # Don't set any environment variables
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(RoutingError) as exc_info:
                await router.call_with_fallback(
                    logical_model="test-model",
                    request_data={"messages": [{"role": "user", "content": "Hi"}]},
                    target_protocol="openai",
                )

        error = exc_info.value
        assert "No routes available" in error.message

    @pytest.mark.asyncio
    async def test_streaming_returns_generator(self, mock_config_loader, mock_executor):
        """Test that streaming returns an async generator."""

        async def mock_stream(route, request_data, target_protocol):
            yield "chunk1"
            yield "chunk2"

        # For streaming, the executor's execute_stream is called directly
        # and should return an async generator
        mock_executor.execute_stream = mock_stream

        router = FallbackRouter(executor=mock_executor)

        with patch.dict(os.environ, {"KEY_A": "key_a"}):
            result = await router.call_with_fallback(
                logical_model="test-model",
                request_data={"messages": [{"role": "user", "content": "Hi"}]},
                target_protocol="openai",
                stream=True,
            )

        # Result should be an async generator (from execute_stream)
        # The router returns the generator directly from the executor
        assert result is not None
        # Collect chunks to verify it works
        chunks = []
        async for chunk in result:
            chunks.append(chunk)
        assert len(chunks) == 2
        assert chunks[0] == "chunk1"
        assert chunks[1] == "chunk2"


class TestFallbackWorthyErrors:
    """Test classification of fallback-worthy errors."""

    @pytest.fixture
    def router(self):
        """Create a FallbackRouter instance."""
        return FallbackRouter()

    def test_http_500_is_fallback_worthy(self, router):
        """Test that HTTP 500 errors are fallback-worthy."""
        error = Exception("Internal server error")
        error.status = 500
        assert router._is_fallback_worthy_error(error) is True

    def test_http_502_is_fallback_worthy(self, router):
        """Test that HTTP 502 errors are fallback-worthy."""
        error = Exception("Bad gateway")
        error.status = 502
        assert router._is_fallback_worthy_error(error) is True

    def test_http_503_is_fallback_worthy(self, router):
        """Test that HTTP 503 errors are fallback-worthy."""
        error = Exception("Service unavailable")
        error.status = 503
        assert router._is_fallback_worthy_error(error) is True

    def test_http_429_is_fallback_worthy(self, router):
        """Test that HTTP 429 rate limit errors are fallback-worthy."""
        error = Exception("Rate limited")
        error.status = 429
        assert router._is_fallback_worthy_error(error) is True

    def test_http_401_triggers_fallback(self, router):
        """Test that HTTP 401 still allows fallback to different key/provider."""
        error = Exception("Unauthorized")
        error.status = 401
        # 401 should still allow fallback (try different key)
        assert router._is_fallback_worthy_error(error) is True

    def test_timeout_error_is_fallback_worthy(self, router):
        """Test that timeout errors are fallback-worthy."""
        assert router._is_fallback_worthy_error(asyncio.TimeoutError()) is True

    def test_connection_error_is_fallback_worthy(self, router):
        """Test that connection errors are fallback-worthy."""
        assert router._is_fallback_worthy_error(Exception("Connection refused")) is True
        assert (
            router._is_fallback_worthy_error(Exception("Network unreachable")) is True
        )

    def test_route_execution_error_is_fallback_worthy(self, router):
        """Test that RouteExecutionError is fallback-worthy."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )
        error = RouteExecutionError(message="Failed", route=route, status_code=500)
        assert router._is_fallback_worthy_error(error) is True

    def test_generic_error_without_transient_message(self, router):
        """Test that generic errors without transient indicators are not fallback-worthy."""
        error = Exception("Some random error")
        assert router._is_fallback_worthy_error(error) is False


class TestConvenienceFunctions:
    """Test convenience functions for routing."""

    @pytest.mark.asyncio
    @patch("app.routing.router.FallbackRouter")
    async def test_call_with_fallback_creates_router(self, mock_router_class):
        """Test that call_with_fallback creates a new router instance."""
        mock_router = Mock()
        mock_router.call_with_fallback = AsyncMock(return_value={"success": True})
        mock_router_class.return_value = mock_router

        result = await call_with_fallback(
            logical_model="test-model",
            request_data={"messages": []},
            target_protocol="openai",
        )

        mock_router_class.assert_called_once()
        mock_router.call_with_fallback.assert_called_once_with(
            logical_model="test-model",
            request_data={"messages": []},
            target_protocol="openai",
            stream=False,
        )


class TestErrorFormatting:
    """Test error message formatting."""

    def test_format_routing_error_message(self):
        """Test formatting of routing error messages."""
        route = ResolvedRoute(
            source_logical_model="test-model",
            wire_protocol="openai",
            provider="test-provider",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )
        attempt = Attempt(route=route, attempt_number=1, is_fallback_route=False)

        router = FallbackRouter()
        errors = [
            {
                "attempt": 1,
                "provider": "test-provider",
                "error": "Connection failed",
                "error_type": "ConnectionError",
            }
        ]

        message = router._format_routing_error_message("test-model", [attempt], errors)

        assert "test-model" in message
        assert "test-provider" in message
        assert "Connection failed" in message

    def test_format_error_with_fallback_marker(self):
        """Test that fallback routes are marked in error message."""
        route = ResolvedRoute(
            source_logical_model="fallback-model",
            wire_protocol="openai",
            provider="fallback-provider",
            model="fallback",
            api_key="key",
            timeout_seconds=60,
        )
        attempt = Attempt(route=route, attempt_number=2, is_fallback_route=True)

        router = FallbackRouter()
        errors = [{"attempt": 2, "error": "Failed", "error_type": "Error"}]

        message = router._format_routing_error_message(
            "original-model", [attempt], errors
        )

        assert "[FALLBACK]" in message
