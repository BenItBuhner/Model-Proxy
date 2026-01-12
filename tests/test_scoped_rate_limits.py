"""
Test suite to verify scoped rate limiting (Scoped Failures).
Ensures that 429/404 errors on one model only block that specific model/provider combo,
while 400/401/403 errors block the key globally for the provider.
"""

import pytest

from app.core.api_key_manager import (
    KeyCycleTracker,
    _rotation_state,
    mark_key_failed,
    reset_rotation_state,
)


@pytest.fixture(autouse=True)
def clean_rotation_state():
    """Reset rotation state before each test."""
    reset_rotation_state()
    yield


def test_model_scoped_failure(monkeypatch):
    """Test that a failure on one model does not block another model for the same provider."""
    provider = "test-provider"
    model_a = "model-a"
    model_b = "model-b"

    # Mock keys in environment for this provider
    monkeypatch.setenv("TEST_PROVIDER_API_KEY_1", "key-1")
    monkeypatch.setenv("TEST_PROVIDER_API_KEY_2", "key-2")

    # 1. Mark key-1 as failed for model-a (scoped)
    mark_key_failed(provider, "key-1", model=f"{provider}/{model_a}")

    # 2. Check availability for model-a
    # Since key-1 is failed for model-a, it should return key-2
    tracker_a = KeyCycleTracker(provider, model=model_a)
    key_received = tracker_a.get_next_key()
    assert key_received == "key-2"

    # After key-2, no more keys are available for model-a in this cycle
    assert tracker_a.get_next_key() is None

    # 3. Check availability for model-b
    # key-1 should still be available for model-b
    tracker_b = KeyCycleTracker(provider, model=model_b)
    keys_received = []
    keys_received.append(tracker_b.get_next_key())
    keys_received.append(tracker_b.get_next_key())

    assert "key-1" in keys_received
    assert "key-2" in keys_received
    assert len(set(keys_received)) == 2


def test_global_failure(monkeypatch):
    """Test that a global failure (e.g. 401) blocks the key for all models."""
    provider = "test-provider"
    model_a = "model-a"
    model_b = "model-b"

    monkeypatch.setenv("TEST_PROVIDER_API_KEY_1", "key-1")

    # 1. Mark key-1 as failed globally
    mark_key_failed(provider, "key-1", model=None)

    # 2. Check availability for model-a
    tracker_a = KeyCycleTracker(provider, model=model_a)
    assert tracker_a.get_next_key() is None

    # 3. Check availability for model-b
    tracker_b = KeyCycleTracker(provider, model=model_b)
    assert tracker_b.get_next_key() is None


def test_all_keys_in_cooldown_scoped(monkeypatch):
    """Test that all_keys_in_cooldown respects model scope."""
    provider = "test-provider"
    model_a = "model-a"
    model_b = "model-b"

    monkeypatch.setenv("TEST_PROVIDER_API_KEY_1", "key-1")

    # Mark key-1 failed for model-a only
    mark_key_failed(provider, "key-1", model=f"{provider}/{model_a}")

    # Should be in cooldown for model-a
    tracker_a = KeyCycleTracker(provider, model=model_a)
    assert tracker_a.all_keys_in_cooldown() is True

    # Should NOT be in cooldown for model-b
    tracker_b = KeyCycleTracker(provider, model=model_b)
    assert tracker_b.all_keys_in_cooldown() is False


def test_tracker_mark_failed_logic(monkeypatch):
    """Test tracker.mark_failed correctly routes to global or scoped state."""
    provider = "test-provider"
    model_a = "model-a"

    monkeypatch.setenv("TEST_PROVIDER_API_KEY_1", "key-1")

    tracker = KeyCycleTracker(provider, model=model_a)

    # 1. Mark failed with action="model_key_failure"
    tracker.mark_failed("key-1", action="model_key_failure")
    state = _rotation_state[provider]
    assert "key-1" in state.model_failed_keys[f"{provider}/{model_a}"]
    assert "key-1" not in state.failed_keys

    # 2. Mark failed with action="global_key_failure"
    tracker.mark_failed("key-1", action="global_key_failure")
    assert "key-1" in state.failed_keys


def test_mixed_failures(monkeypatch):
    """Test interaction between global and model-scoped failures."""
    provider = "test-provider"
    model_a = "model-a"

    monkeypatch.setenv("TEST_PROVIDER_API_KEY_1", "key-1")
    monkeypatch.setenv("TEST_PROVIDER_API_KEY_2", "key-2")

    # key-1 failed globally
    mark_key_failed(provider, "key-1", model=None)
    # key-2 failed for model-a
    mark_key_failed(provider, "key-2", model=f"{provider}/{model_a}")

    tracker = KeyCycleTracker(provider, model=model_a)
    # Both keys should be considered in cooldown for model-a
    assert tracker.get_next_key() is None
    assert tracker.all_keys_in_cooldown() is True


def test_error_code_classification():
    """Test that FallbackRouter correctly classifies errors as global or scoped."""
    from app.routing.executor import RouteExecutionError
    from app.routing.models import ResolvedRoute
    from app.routing.router import FallbackRouter

    router = FallbackRouter()
    route = ResolvedRoute(
        source_logical_model="test",
        wire_protocol="openai",
        provider="test",
        model="test",
        api_key="test",
        timeout_seconds=60,
    )

    # Global: 401, 403
    for code in [401, 403]:
        err = RouteExecutionError("err", route=route, status_code=code)
        action = router.resolve_error_action(route.provider, err)
        assert action["action"] == "global_key_failure", (
            f"Status {code} should be global"
        )

    # Scoped: 400, 404, 429, 500
    # Note: 400 is now scoped by default unless mapped otherwise
    for code in [400, 404, 429, 500]:
        err = RouteExecutionError("err", route=route, status_code=code)
        action = router.resolve_error_action(route.provider, err)
        assert action["action"] == "model_key_failure", (
            f"Status {code} should be scoped"
        )
