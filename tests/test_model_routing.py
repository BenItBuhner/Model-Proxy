"""
Unit tests for model routing and fallback functionality.
Tests the new multi-level fallback system with API key, provider, and model fallbacks.
"""

import asyncio
import json
import os
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.routing.config_loader import ModelConfigLoader
from app.routing.models import (
    Attempt,
    ModelRoutingConfig,
    ResolvedRoute,
    RouteConfig,
    RoutingError,
)
from app.routing.router import FallbackRouter


class TestModelRoutingConfig:
    """Test routing configuration models."""

    def test_valid_config(self):
        """Test parsing a valid routing config."""
        config_data = {
            "logical_name": "glm-4.6",
            "timeout_seconds": 60,
            "model_routings": [
                {
                    "id": "primary",
                    "wire_protocol": "openai",
                    "provider": "cerebras",
                    "model": "zai-glm-4.6",
                    "api_key_env": ["CEREBRAS_API_KEY"],
                }
            ],
            "fallback_model_routings": ["glm-4.5"],
        }

        config = ModelRoutingConfig(**config_data)
        assert config.logical_name == "glm-4.6"
        assert config.timeout_seconds == 60
        assert len(config.model_routings) == 1
        assert config.fallback_model_routings == ["glm-4.5"]

    def test_config_with_multiple_routes(self):
        """Test config with multiple provider routes."""
        config_data = {
            "logical_name": "test-model",
            "model_routings": [
                {
                    "id": "primary",
                    "wire_protocol": "openai",
                    "provider": "cerebras",
                    "model": "model-a",
                    "api_key_env": ["KEY1", "KEY2"],
                },
                {
                    "id": "secondary",
                    "wire_protocol": "openai",
                    "provider": "nahcrof",
                    "model": "model-b",
                    "api_key_env": ["KEY3"],
                },
            ],
        }

        config = ModelRoutingConfig(**config_data)
        assert len(config.model_routings) == 2
        assert config.model_routings[0].provider == "cerebras"
        assert config.model_routings[1].provider == "nahcrof"

    def test_config_with_base_url_override(self):
        """Test config with base URL override."""
        config_data = {
            "logical_name": "test-model",
            "model_routings": [
                {
                    "provider": "custom",
                    "model": "custom-model",
                    "base_url": "https://custom.api.com/v1",
                }
            ],
        }

        config = ModelRoutingConfig(**config_data)
        assert config.model_routings[0].base_url == "https://custom.api.com/v1"

    def test_config_with_optional_fields(self):
        """Test config when wire protocol and api keys are omitted."""
        config_data = {
            "logical_name": "test-model",
            "model_routings": [
                {
                    "provider": "cerebras",
                    "model": "model-a",
                }
            ],
        }

        config = ModelRoutingConfig(**config_data)
        assert config.model_routings[0].wire_protocol is None
        assert config.model_routings[0].api_key_env is None

    def test_config_validation_missing_required(self):
        """Test config validation for missing required fields."""
        with pytest.raises(Exception):
            ModelRoutingConfig(logical_name="test")  # Missing model_routings

    def test_config_validation_invalid_wire_protocol(self):
        """Test config validation for invalid wire protocol."""
        with pytest.raises(Exception):
            RouteConfig(
                wire_protocol="invalid",  # Should be "openai" or "anthropic"
                provider="test",
                model="test",
                api_key_env=["TEST_KEY"],
            )

    def test_route_config_defaults(self):
        """Test RouteConfig default values."""
        route = RouteConfig(
            provider="test",
            model="test-model",
        )

        assert route.id is None
        assert route.base_url is None
        assert route.timeout_seconds is None
        assert route.wire_protocol is None
        assert route.api_key_env is None


class TestResolvedRoute:
    """Test ResolvedRoute model."""

    def test_resolved_route_creation(self):
        """Test creating a resolved route."""
        route = ResolvedRoute(
            source_logical_model="glm-4.6",
            wire_protocol="openai",
            provider="cerebras",
            model="zai-glm-4.6",
            api_key="test-api-key",
            timeout_seconds=60,
        )

        assert route.source_logical_model == "glm-4.6"
        assert route.wire_protocol == "openai"
        assert route.provider == "cerebras"
        assert route.model == "zai-glm-4.6"
        assert route.api_key == "test-api-key"
        assert route.timeout_seconds == 60
        assert route.base_url is None
        assert route.route_id is None


class TestAttempt:
    """Test Attempt model."""

    def test_attempt_creation(self):
        """Test creating an attempt."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )

        attempt = Attempt(route=route, attempt_number=1, is_fallback_route=False)

        assert attempt.route == route
        assert attempt.attempt_number == 1
        assert attempt.is_fallback_route is False

    def test_fallback_attempt(self):
        """Test creating a fallback attempt."""
        route = ResolvedRoute(
            source_logical_model="fallback-model",
            wire_protocol="openai",
            provider="fallback",
            model="fallback",
            api_key="key",
            timeout_seconds=60,
        )

        attempt = Attempt(route=route, attempt_number=5, is_fallback_route=True)

        assert attempt.is_fallback_route is True


class TestRoutingError:
    """Test RoutingError exception."""

    def test_routing_error_creation(self):
        """Test creating a routing error."""
        route = ResolvedRoute(
            source_logical_model="test",
            wire_protocol="openai",
            provider="test",
            model="test",
            api_key="key",
            timeout_seconds=60,
        )
        attempt = Attempt(route=route, attempt_number=1)

        error = RoutingError(
            logical_model="test-model",
            attempted_routes=[attempt],
            errors=[{"error": "Test error", "error_type": "TestError"}],
            message="All routes failed",
        )

        assert error.logical_model == "test-model"
        assert len(error.attempted_routes) == 1
        assert len(error.errors) == 1
        assert "All routes failed" in str(error)

    def test_routing_error_to_dict(self):
        """Test converting routing error to dictionary."""
        error = RoutingError(
            logical_model="test",
            attempted_routes=[],
            errors=[{"error": "test"}],
            message="Test message",
        )

        error_dict = error.to_dict()

        assert error_dict["logical_model"] == "test"
        assert error_dict["message"] == "Test message"
        assert "attempted_routes_count" in error_dict

    def test_routing_error_summary(self):
        """Test error summary generation."""
        error = RoutingError(
            logical_model="test-model",
            attempted_routes=[Mock(), Mock()],
            errors=[{"error": "e1"}, {"error": "e2"}],
            message="Test message",
        )

        summary = error.get_error_summary()

        assert "test-model" in summary
        assert "2" in summary  # Route count


class TestConfigLoader:
    """Test configuration loading."""

    def test_load_config_from_file(self, tmp_path):
        """Test loading a config file."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        config_file = config_dir / "test-model.json"
        config_data = {
            "logical_name": "test-model",
            "model_routings": [
                {
                    "wire_protocol": "openai",
                    "provider": "test",
                    "model": "test-model",
                    "api_key_env": ["TEST_API_KEY"],
                }
            ],
        }

        with open(config_file, "w") as f:
            json.dump(config_data, f)

        loader = ModelConfigLoader(config_dir)
        config = loader.load_config("test-model")

        assert config.logical_name == "test-model"
        assert len(config.model_routings) == 1

    def test_load_config_caching(self, tmp_path):
        """Test that configs are cached."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        config_file = config_dir / "cached-model.json"
        config_data = {
            "logical_name": "cached-model",
            "model_routings": [
                {
                    "wire_protocol": "openai",
                    "provider": "test",
                    "model": "test",
                    "api_key_env": ["KEY"],
                }
            ],
        }

        with open(config_file, "w") as f:
            json.dump(config_data, f)

        loader = ModelConfigLoader(config_dir)

        # First load
        config1 = loader.load_config("cached-model")
        # Second load should use cache
        config2 = loader.load_config("cached-model")

        assert config1 is config2

    def test_missing_config_file(self, tmp_path):
        """Test loading non-existent config."""
        loader = ModelConfigLoader(tmp_path / "models")

        with pytest.raises(FileNotFoundError):
            loader.load_config("nonexistent-model")

    def test_invalid_json_file(self, tmp_path):
        """Test loading invalid JSON."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        config_file = config_dir / "bad-model.json"
        with open(config_file, "w") as f:
            f.write("invalid json {")

        loader = ModelConfigLoader(config_dir)

        with pytest.raises(ValueError):
            loader.load_config("bad-model")

    def test_logical_name_mismatch(self, tmp_path):
        """Test error when logical_name doesn't match filename."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        config_file = config_dir / "model-a.json"
        config_data = {
            "logical_name": "model-b",  # Mismatch!
            "model_routings": [
                {
                    "wire_protocol": "openai",
                    "provider": "test",
                    "model": "test",
                    "api_key_env": ["KEY"],
                }
            ],
        }

        with open(config_file, "w") as f:
            json.dump(config_data, f)

        loader = ModelConfigLoader(config_dir)

        with pytest.raises(ValueError) as exc_info:
            loader.load_config("model-a")

        assert "mismatch" in str(exc_info.value).lower()

    def test_get_available_models(self, tmp_path):
        """Test listing available models."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        # Create some config files
        for name in ["model-a", "model-b", "model-c"]:
            config_file = config_dir / f"{name}.json"
            config_data = {
                "logical_name": name,
                "model_routings": [
                    {
                        "wire_protocol": "openai",
                        "provider": "test",
                        "model": "test",
                        "api_key_env": ["KEY"],
                    }
                ],
            }
            with open(config_file, "w") as f:
                json.dump(config_data, f)

        loader = ModelConfigLoader(config_dir)
        models = loader.get_available_models()

        assert len(models) == 3
        assert "model-a" in models
        assert "model-b" in models
        assert "model-c" in models

    def test_reload_config(self, tmp_path):
        """Test force reloading a config."""
        config_dir = tmp_path / "models"
        config_dir.mkdir()

        config_file = config_dir / "reload-model.json"
        config_data = {
            "logical_name": "reload-model",
            "timeout_seconds": 30,
            "model_routings": [
                {
                    "wire_protocol": "openai",
                    "provider": "test",
                    "model": "test",
                    "api_key_env": ["KEY"],
                }
            ],
        }

        with open(config_file, "w") as f:
            json.dump(config_data, f)

        loader = ModelConfigLoader(config_dir)

        # First load
        config1 = loader.load_config("reload-model")
        assert config1.timeout_seconds == 30

        # Modify file
        config_data["timeout_seconds"] = 120
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        # Reload
        config2 = loader.reload_config("reload-model")
        assert config2.timeout_seconds == 120


class TestFallbackRouter:
    """Test the fallback router logic."""

    @pytest.fixture
    def mock_config_loader(self):
        """Create a mock config loader with test configurations."""
        with patch("app.routing.router.config_loader") as mock_loader:
            # Mock glm-4.6 config
            glm46_config = ModelRoutingConfig(
                logical_name="glm-4.6",
                timeout_seconds=60,
                model_routings=[
                    RouteConfig(
                        id="primary",
                        wire_protocol="openai",
                        provider="cerebras",
                        model="zai-glm-4.6",
                        api_key_env=["CEREBRAS_KEY1", "CEREBRAS_KEY2"],
                    ),
                    RouteConfig(
                        id="secondary",
                        wire_protocol="openai",
                        provider="nahcrof",
                        model="glm-4.6",
                        api_key_env=["NAHCROF_KEY1"],
                    ),
                ],
                fallback_model_routings=["glm-4.5"],
            )

            # Mock glm-4.5 config (fallback)
            glm45_config = ModelRoutingConfig(
                logical_name="glm-4.5",
                timeout_seconds=60,
                model_routings=[
                    RouteConfig(
                        wire_protocol="openai",
                        provider="nahcrof",
                        model="glm-4.5",
                        api_key_env=["NAHCROF_KEY1"],
                    )
                ],
                fallback_model_routings=["qwen3-coder"],
            )

            # Mock qwen3-coder config (second-level fallback)
            qwen_config = ModelRoutingConfig(
                logical_name="qwen3-coder",
                timeout_seconds=60,
                model_routings=[
                    RouteConfig(
                        wire_protocol="openai",
                        provider="nahcrof",
                        model="qwen3-coder",
                        api_key_env=["NAHCROF_KEY1"],
                    )
                ],
            )

            def mock_load_config(logical_model):
                configs = {
                    "glm-4.6": glm46_config,
                    "glm-4.5": glm45_config,
                    "qwen3-coder": qwen_config,
                }
                if logical_model in configs:
                    return configs[logical_model]
                raise FileNotFoundError(f"No config for {logical_model}")

            mock_loader.load_config.side_effect = mock_load_config
            yield mock_loader

    @pytest.fixture
    def mock_executor(self):
        """Create a mock route executor."""
        with patch("app.routing.router.get_executor") as mock_get:
            executor = Mock()
            executor.execute = AsyncMock()
            executor.execute_stream = AsyncMock()
            mock_get.return_value = executor
            yield executor

    def test_resolve_attempts_basic(self, mock_config_loader):
        """Test basic attempt resolution."""
        router = FallbackRouter()

        with patch.dict(
            os.environ,
            {
                "CEREBRAS_KEY1": "cerebras_key_1",
                "CEREBRAS_KEY2": "cerebras_key_2",
                "NAHCROF_KEY1": "nahcrof_key_1",
            },
        ):
            attempts = router.resolve_attempts("glm-4.6")

        # Should have attempts for each API key
        # 2 from cerebras + 1 from nahcrof (primary) + 1 from nahcrof (fallback glm-4.5) + 1 from qwen3-coder
        assert len(attempts) >= 3

        # First attempts should be primary route (cerebras)
        assert attempts[0].route.provider == "cerebras"
        assert attempts[0].route.api_key == "cerebras_key_1"
        assert attempts[0].is_fallback_route is False

        assert attempts[1].route.provider == "cerebras"
        assert attempts[1].route.api_key == "cerebras_key_2"

    def test_resolve_attempts_uses_provider_defaults(self):
        """Test that provider-derived keys and protocol are used when omitted."""
        router = FallbackRouter()
        config = ModelRoutingConfig(
            logical_name="model-x",
            model_routings=[
                RouteConfig(
                    provider="cerebras",
                    model="model-x",
                )
            ],
        )

        with (
            patch("app.routing.router.config_loader.load_config", return_value=config),
            patch(
                "app.routing.router.get_available_keys", return_value=["key1", "key2"]
            ),
            patch(
                "app.routing.router.get_provider_wire_protocol", return_value="openai"
            ),
        ):
            attempts = router.resolve_attempts("model-x")

        assert len(attempts) == 2
        assert attempts[0].route.api_key == "key1"
        assert attempts[0].route.wire_protocol == "openai"

    def test_resolve_attempts_includes_fallbacks(self, mock_config_loader):
        """Test that fallback logical models are included."""
        router = FallbackRouter()

        with patch.dict(os.environ, {"NAHCROF_KEY1": "key1"}):
            attempts = router.resolve_attempts("glm-4.6")

        # Should include fallback attempts
        fallback_attempts = [a for a in attempts if a.is_fallback_route]
        assert len(fallback_attempts) >= 1

        # Fallback should be from glm-4.5
        fallback_models = {a.route.source_logical_model for a in fallback_attempts}
        assert "glm-4.5" in fallback_models or "qwen3-coder" in fallback_models

    def test_resolve_attempts_skips_missing_keys(self, mock_config_loader):
        """Test that attempts with missing API keys are skipped."""
        router = FallbackRouter()

        # Only provide one key
        with patch.dict(os.environ, {"CEREBRAS_KEY1": "key1"}, clear=True):
            attempts = router.resolve_attempts("glm-4.6")

        # Should only have attempts for CEREBRAS_KEY1
        cerebras_attempts = [a for a in attempts if a.route.provider == "cerebras"]
        assert len(cerebras_attempts) == 1

    def test_attempt_numbering(self, mock_config_loader):
        """Test that attempts are numbered sequentially."""
        router = FallbackRouter()

        with patch.dict(
            os.environ,
            {"CEREBRAS_KEY1": "key1", "CEREBRAS_KEY2": "key2", "NAHCROF_KEY1": "key3"},
        ):
            attempts = router.resolve_attempts("glm-4.6")

        # Check sequential numbering
        for i, attempt in enumerate(attempts, 1):
            assert attempt.attempt_number == i

    def test_cycle_detection(self, mock_config_loader):
        """Test detection of cycles in fallback configs."""
        # Create a cycle: model-a -> model-b -> model-a
        cycle_config_a = ModelRoutingConfig(
            logical_name="model-a",
            model_routings=[
                RouteConfig(
                    wire_protocol="openai",
                    provider="test",
                    model="test",
                    api_key_env=["KEY_A"],
                )
            ],
            fallback_model_routings=["model-b"],
        )

        cycle_config_b = ModelRoutingConfig(
            logical_name="model-b",
            model_routings=[
                RouteConfig(
                    wire_protocol="openai",
                    provider="test",
                    model="test",
                    api_key_env=["KEY_B"],
                )
            ],
            fallback_model_routings=["model-a"],  # Creates cycle back to model-a
        )

        def mock_load_with_cycle(logical_model):
            if logical_model == "model-a":
                return cycle_config_a
            elif logical_model == "model-b":
                return cycle_config_b
            raise FileNotFoundError(f"No config for {logical_model}")

        mock_config_loader.load_config.side_effect = mock_load_with_cycle

        router = FallbackRouter()

        with patch.dict(os.environ, {"KEY_A": "key_a", "KEY_B": "key_b"}):
            attempts = router.resolve_attempts("model-a")

        # Should have attempts from model-a and model-b, but not cycle back
        models_seen = {a.route.source_logical_model for a in attempts}
        assert "model-a" in models_seen
        assert "model-b" in models_seen
        # Each model should only appear once (no duplicate cycles)
        model_a_count = sum(
            1 for a in attempts if a.route.source_logical_model == "model-a"
        )
        model_b_count = sum(
            1 for a in attempts if a.route.source_logical_model == "model-b"
        )
        assert model_a_count == 1
        assert model_b_count == 1


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

    def test_http_429_is_fallback_worthy(self, router):
        """Test that HTTP 429 rate limit errors are fallback-worthy."""
        error = Exception("Rate limited")
        error.status = 429
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
