import time
import pytest
from unittest.mock import patch, MagicMock
from app.core.api_key_manager import (
    KeyCycleTracker,
    reset_rotation_state,
    _rotation_state,
    mark_key_failed,
    mark_provider_failed,
)
from app.routing.router import FallbackRouter
from app.routing.models import RouteConfig, ModelRoutingConfig


@pytest.fixture(autouse=True)
def clean_state():
    reset_rotation_state()
    yield


def test_provider_wide_cooldown(monkeypatch):
    """Test that provider_cooldown action blocks all keys for that provider."""
    provider = "cerebras"
    monkeypatch.setenv("CEREBRAS_API_KEY", "key-1")

    state = _rotation_state[provider]
    current_time = time.time()

    # Trigger provider-wide cooldown for 100s
    mark_provider_failed(provider, cooldown_duration=100)

    assert state.provider_failed_until > current_time

    tracker = KeyCycleTracker(provider)
    assert tracker.get_next_key() is None
    assert tracker.all_keys_in_cooldown() is True

    # Fast forward time
    with patch("time.time", return_value=current_time + 101):
        assert tracker.get_next_key() == "key-1"
        assert tracker.all_keys_in_cooldown() is False


def test_unified_model_cooldown(monkeypatch):
    """Test that model cooldowns are unified across different trackers using provider/model key."""
    provider = "nahcrof"
    model = "glm-4.7"
    route_key = f"{provider}/{model}"

    monkeypatch.setenv("NAHCROF_API_KEY", "key-1")

    # Mark failed for this provider/model combo
    mark_key_failed(provider, "key-1", model=route_key, cooldown_duration=100)

    # Tracker for same provider/model should see it as in cooldown
    tracker1 = KeyCycleTracker(provider, model=model)
    assert tracker1.get_next_key() is None

    # Tracker with same provider/model but different logical context should also see it
    tracker2 = KeyCycleTracker(provider, model=model)
    assert tracker2.all_keys_in_cooldown() is True


def test_granular_duration_priority(monkeypatch):
    """Test priority of cooldown duration lookup in _create_tracker_for_route."""
    router = FallbackRouter()

    provider = "test-provider"
    model = "test-model"

    # Mock provider config
    mock_provider_config = {
        "rate_limiting": {"cooldown_seconds": 100},
        "models": {model: {"cooldown_seconds": 200}},
    }

    route_config = RouteConfig(provider=provider, model=model)
    model_config = ModelRoutingConfig(
        logical_name="logical", default_cooldown_seconds=300, model_routings=[]
    )

    with patch(
        "app.routing.router.get_provider_config", return_value=mock_provider_config
    ):
        # 1. No route override -> should use provider-model specific (200)
        tracker = router._create_tracker_for_route(route_config, model_config)
        assert tracker.route_cooldown == 200

        # 2. Route override exists -> should use route override (50)
        route_config_override = RouteConfig(
            provider=provider, model=model, cooldown_seconds=50
        )
        tracker = router._create_tracker_for_route(route_config_override, model_config)
        assert tracker.route_cooldown == 50

        # 3. No model specific, no route override -> should use model default (300)
        mock_provider_config_no_model = {
            "rate_limiting": {"cooldown_seconds": 100},
            "models": {},
        }
        with patch(
            "app.routing.router.get_provider_config",
            return_value=mock_provider_config_no_model,
        ):
            tracker = router._create_tracker_for_route(route_config, model_config)
            assert tracker.route_cooldown == 300


def test_resolve_error_action():
    """Test mapping of status codes to actions."""
    router = FallbackRouter()
    provider = "cerebras"

    mock_config = {
        "error_handling": {
            "400": {"action": "provider_cooldown", "cooldown_seconds": 600}
        }
    }

    with patch("app.routing.router.get_provider_config", return_value=mock_config):
        # Mapped error
        err400 = MagicMock()
        err400.status = 400
        action = router.resolve_error_action(provider, err400)
        assert action["action"] == "provider_cooldown"
        assert action["cooldown_seconds"] == 600

        # Unmapped standard global error
        err401 = MagicMock()
        err401.status = 401
        action = router.resolve_error_action(provider, err401)
        assert action["action"] == "global_key_failure"

        # Unmapped standard model error
        err429 = MagicMock()
        err429.status = 429
        action = router.resolve_error_action(provider, err429)
        assert action["action"] == "model_key_failure"


def test_tracker_mark_failed_with_custom_action(monkeypatch):
    """Test that tracker.mark_failed correctly handles actions and durations."""
    provider = "test-provider"
    model = "test-model"
    monkeypatch.setenv("TEST_PROVIDER_API_KEY", "key-1")

    tracker = KeyCycleTracker(
        provider=provider, model=model, provider_cooldown=100, route_cooldown=200
    )

    # Test model_key_failure
    tracker.mark_failed("key-1", action="model_key_failure")
    fail_time, duration = _rotation_state[provider].model_failed_keys[
        f"{provider}/{model}"
    ]["key-1"]
    assert duration == 200

    # Test global_key_failure
    tracker.mark_failed("key-1", action="global_key_failure")
    fail_time, duration = _rotation_state[provider].failed_keys["key-1"]
    assert duration == 100

    # Test provider_cooldown
    tracker.mark_failed("key-1", action="provider_cooldown", cooldown_duration=500)
    assert _rotation_state[provider].provider_failed_until > time.time() + 490
