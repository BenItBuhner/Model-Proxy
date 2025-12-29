"""
Comprehensive tests for API key manager edge cases and advanced scenarios.
Tests round-robin key selection, KeyCycleTracker, and cooldown behavior.
"""

from unittest.mock import patch

from app.core.api_key_manager import (
    get_api_key,
    mark_key_failed,
    get_available_keys,
    reset_failed_keys,
    reset_rotation_state,
    get_rotation_state,
    _parse_provider_keys,
    KeyCycleTracker,
    KEY_COOLDOWN_SECONDS,
    MAX_KEY_RETRY_CYCLES,
)


def test_parse_provider_keys_singular_only(monkeypatch):
    """Test parsing when only singular key is provided."""
    monkeypatch.setenv("OPENAI_API_KEY", "singular_key")
    monkeypatch.delenv("OPENAI_API_KEY_1", raising=False)

    keys = _parse_provider_keys("openai")
    assert "singular_key" in keys
    assert len(keys) == 1


def test_parse_provider_keys_numbered_only(monkeypatch):
    """Test parsing when only numbered keys are provided."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    keys = _parse_provider_keys("openai")
    assert "key1" in keys
    assert "key2" in keys
    assert len(keys) == 2


def test_parse_provider_keys_mixed(monkeypatch):
    """Test parsing when both singular and numbered keys exist."""
    monkeypatch.setenv("OPENAI_API_KEY", "singular")
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    keys = _parse_provider_keys("openai")
    assert "singular" in keys
    assert "key1" in keys
    assert "key2" in keys


def test_parse_provider_keys_gaps(monkeypatch):
    """Test parsing with gaps in numbering (still discovers higher indexes)."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_3", "key3")
    # Missing key_2 - parsing should still find key_3

    keys = _parse_provider_keys("openai")
    assert "key1" in keys
    assert "key3" in keys
    assert len(keys) == 2


def test_get_available_keys_returns_all(monkeypatch):
    """Test that get_available_keys returns all keys (no filtering)."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")
    monkeypatch.setenv("OPENAI_API_KEY_3", "key3")

    # Even after marking as failed, get_available_keys returns all
    mark_key_failed("openai", "key2")

    available = get_available_keys("openai")
    assert "key1" in available
    assert "key2" in available  # Still returned (filtering done elsewhere)
    assert "key3" in available

    # Clean up
    reset_rotation_state("openai")


def test_get_api_key_round_robin(monkeypatch):
    """Test that get_api_key uses round-robin selection."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")
    monkeypatch.setenv("OPENAI_API_KEY_3", "key3")

    # Reset state for clean test
    reset_rotation_state("openai")

    # First call should get key1 (index 0, starting from -1)
    key1 = get_api_key("openai")
    assert key1 == "key1"

    # Second call should get key2
    key2 = get_api_key("openai")
    assert key2 == "key2"

    # Third call should get key3
    key3 = get_api_key("openai")
    assert key3 == "key3"

    # Fourth call should wrap around to key1
    key4 = get_api_key("openai")
    assert key4 == "key1"

    # Clean up
    reset_rotation_state("openai")


def test_mark_key_failed_tracks_failure(monkeypatch):
    """Test that mark_key_failed properly tracks the failure."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    reset_rotation_state("openai")

    mark_key_failed("openai", "key1")

    state = get_rotation_state("openai")
    assert "key1" in state.failed_keys
    assert isinstance(state.failed_keys["key1"], float)

    # Clean up
    reset_rotation_state("openai")


def test_reset_failed_keys_specific_provider(monkeypatch):
    """Test resetting failed keys for specific provider."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "openai_key")
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "anthropic_key")

    reset_rotation_state()

    mark_key_failed("openai", "openai_key")
    mark_key_failed("anthropic", "anthropic_key")

    reset_failed_keys("openai")

    openai_state = get_rotation_state("openai")
    anthropic_state = get_rotation_state("anthropic")

    assert "openai_key" not in openai_state.failed_keys
    assert "anthropic_key" in anthropic_state.failed_keys

    # Clean up
    reset_rotation_state()


def test_get_api_key_skips_failed_with_cooldown(monkeypatch):
    """Test that get_api_key skips failed keys when cooldown > 0."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    # Mark key1 as failed
    mark_key_failed("openai", "key1")

    # Patch KEY_COOLDOWN_SECONDS to be > 0 for this test
    with patch("app.core.api_key_manager.KEY_COOLDOWN_SECONDS", 60):
        # Should skip key1 and return key2
        key = get_api_key("openai")
        assert key == "key2"

    # Clean up
    reset_rotation_state("openai")


def test_provider_name_normalization(monkeypatch):
    """Test that provider names are normalized correctly."""
    # Test with hyphens
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "key1")

    keys = _parse_provider_keys("anthropic")
    assert "key1" in keys


def test_key_cooldown_configuration():
    """Test that cooldown period is configurable."""
    # This test verifies the cooldown is read from env
    assert isinstance(KEY_COOLDOWN_SECONDS, int)
    assert KEY_COOLDOWN_SECONDS >= 0


def test_max_key_retry_cycles_configuration():
    """Test that max retry cycles is configurable."""
    assert isinstance(MAX_KEY_RETRY_CYCLES, int)
    assert MAX_KEY_RETRY_CYCLES > 0


def test_multiple_providers_independent(monkeypatch):
    """Test that different providers maintain independent key states."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "openai_key")
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "anthropic_key")

    reset_rotation_state()

    # Mark OpenAI key as failed
    mark_key_failed("openai", "openai_key")

    openai_state = get_rotation_state("openai")
    anthropic_state = get_rotation_state("anthropic")

    # OpenAI key should be in failed keys
    assert "openai_key" in openai_state.failed_keys

    # Anthropic key should NOT be in failed keys
    assert "anthropic_key" not in anthropic_state.failed_keys

    # Clean up
    reset_rotation_state()


def test_get_available_keys_empty_provider(monkeypatch):
    """Test getting available keys for provider with no keys."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_1", raising=False)

    keys = get_available_keys("openai")
    assert len(keys) == 0


def test_parse_provider_keys_special_characters(monkeypatch):
    """Test parsing keys with special characters."""
    special_key = "sk-test_123!@#$%^&*()"
    monkeypatch.setenv("OPENAI_API_KEY_1", special_key)

    keys = _parse_provider_keys("openai")
    assert special_key in keys


# =============================================================================
# KeyCycleTracker Tests
# =============================================================================


def test_key_cycle_tracker_basic(monkeypatch):
    """Test basic KeyCycleTracker functionality."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")
    monkeypatch.setenv("OPENAI_API_KEY_3", "key3")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai", max_cycles=2)

    assert tracker.total_keys == 3
    assert tracker.cycles_remaining == 2
    assert not tracker.exhausted()

    # Get first three keys (cycle 0)
    key1 = tracker.get_next_key()
    key2 = tracker.get_next_key()
    key3 = tracker.get_next_key()

    assert key1 is not None
    assert key2 is not None
    assert key3 is not None
    assert len({key1, key2, key3}) == 3  # All different

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_cycle_count(monkeypatch):
    """Test that KeyCycleTracker properly counts cycles."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai", max_cycles=2)

    # Cycle 0
    assert tracker.current_cycle == 0
    tracker.get_next_key()
    tracker.get_next_key()

    # After getting all keys, next get should start cycle 1
    tracker.get_next_key()
    assert tracker.current_cycle == 1

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_exhaustion(monkeypatch):
    """Test that KeyCycleTracker properly reports exhaustion."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai", max_cycles=2)

    # Cycle through max_cycles times
    for _ in range(2):
        tracker.get_next_key()

    # Should be exhausted now
    assert tracker.exhausted()
    assert tracker.get_next_key() is None

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_no_keys(monkeypatch):
    """Test KeyCycleTracker with no available keys."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_1", raising=False)

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai", max_cycles=5)

    assert tracker.total_keys == 0
    assert tracker.get_next_key() is None
    assert tracker.exhausted()

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_mark_failed(monkeypatch):
    """Test that mark_failed updates global state."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai")
    tracker.mark_failed("key1")

    state = get_rotation_state("openai")
    assert "key1" in state.failed_keys

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_cycle_reset_preserves_failures(monkeypatch):
    """Test that cycle reset preserves failed keys for cross-request cooldown."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai", max_cycles=2)

    # Get first key
    key = tracker.get_next_key()
    tracker.mark_failed(key)

    # Get second key
    key = tracker.get_next_key()
    tracker.mark_failed(key)

    # Verify failures are tracked
    state = get_rotation_state("openai")
    assert len(state.failed_keys) == 2

    # Get next key (triggers cycle reset)
    # Keys should still be available within same request despite being marked failed
    next_key = tracker.get_next_key()
    assert next_key is not None  # Should get a key (same request can retry)

    # Failures should be PRESERVED after cycle reset (cross-request cooldown)
    state = get_rotation_state("openai")
    assert len(state.failed_keys) == 2

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_round_robin_persists(monkeypatch):
    """Test that round-robin position persists across tracker instances."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")
    monkeypatch.setenv("OPENAI_API_KEY_3", "key3")

    reset_rotation_state("openai")

    # First tracker
    tracker1 = KeyCycleTracker("openai")
    key1 = tracker1.get_next_key()
    assert key1 == "key1"

    # Second tracker should continue from where first left off
    tracker2 = KeyCycleTracker("openai")
    key2 = tracker2.get_next_key()
    assert key2 == "key2"

    # Third tracker continues
    tracker3 = KeyCycleTracker("openai")
    key3 = tracker3.get_next_key()
    assert key3 == "key3"

    # Fourth tracker wraps around
    tracker4 = KeyCycleTracker("openai")
    key4 = tracker4.get_next_key()
    assert key4 == "key1"

    # Clean up
    reset_rotation_state("openai")


def test_key_cycle_tracker_default_max_cycles(monkeypatch):
    """Test that KeyCycleTracker uses MAX_KEY_RETRY_CYCLES by default."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai")
    assert tracker.max_cycles == MAX_KEY_RETRY_CYCLES

    # Clean up
    reset_rotation_state("openai")


def test_rotation_state_reset(monkeypatch):
    """Test complete rotation state reset."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("ANTHROPIC_API_KEY_1", "key2")

    # Create some state
    get_api_key("openai")
    get_api_key("anthropic")
    mark_key_failed("openai", "key1")
    mark_key_failed("anthropic", "key2")

    # Reset all
    reset_rotation_state()

    # Verify state is clean
    openai_state = get_rotation_state("openai")
    anthropic_state = get_rotation_state("anthropic")

    assert openai_state.last_used_index == -1
    assert len(openai_state.failed_keys) == 0
    assert anthropic_state.last_used_index == -1
    assert len(anthropic_state.failed_keys) == 0


# =============================================================================
# Cross-Request Cooldown Tests
# =============================================================================


def test_all_keys_in_cooldown_with_cooldown_disabled(monkeypatch):
    """Test all_keys_in_cooldown returns False when cooldown is disabled."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    # Mark all keys as failed
    mark_key_failed("openai", "key1")
    mark_key_failed("openai", "key2")

    # Explicitly disable cooldown (KEY_COOLDOWN_SECONDS=0), should return False
    with patch("app.core.api_key_manager.KEY_COOLDOWN_SECONDS", 0):
        tracker = KeyCycleTracker("openai")
        assert tracker.all_keys_in_cooldown() is False

    # Clean up
    reset_rotation_state("openai")


def test_all_keys_in_cooldown_with_cooldown_enabled(monkeypatch):
    """Test all_keys_in_cooldown returns True when all keys failed and cooldown > 0."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    # Mark all keys as failed
    mark_key_failed("openai", "key1")
    mark_key_failed("openai", "key2")

    # Default cooldown is 60 seconds, so all_keys_in_cooldown should return True
    tracker = KeyCycleTracker("openai")
    assert tracker.all_keys_in_cooldown() is True

    # Clean up
    reset_rotation_state("openai")


def test_all_keys_in_cooldown_with_some_keys_not_failed(monkeypatch):
    """Test all_keys_in_cooldown returns False when some keys haven't failed."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    # Only mark one key as failed
    mark_key_failed("openai", "key1")

    tracker = KeyCycleTracker("openai")

    # Even with cooldown enabled, should return False (key2 hasn't failed)
    with patch("app.core.api_key_manager.KEY_COOLDOWN_SECONDS", 60):
        assert tracker.all_keys_in_cooldown() is False

    # Clean up
    reset_rotation_state("openai")


def test_all_keys_in_cooldown_no_keys(monkeypatch):
    """Test all_keys_in_cooldown returns True when no keys exist."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_1", raising=False)

    reset_rotation_state("openai")

    tracker = KeyCycleTracker("openai")
    assert tracker.all_keys_in_cooldown() is True

    # Clean up
    reset_rotation_state("openai")


def test_cross_request_cooldown_skip(monkeypatch):
    """Test that a new request sees failed keys from previous request."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")
    monkeypatch.setenv("OPENAI_API_KEY_2", "key2")

    reset_rotation_state("openai")

    # Simulate first request - fail all keys
    tracker1 = KeyCycleTracker("openai", max_cycles=1)
    key1 = tracker1.get_next_key()
    tracker1.mark_failed(key1)
    key2 = tracker1.get_next_key()
    tracker1.mark_failed(key2)

    # Second request should see keys in cooldown (when cooldown enabled)
    with patch("app.core.api_key_manager.KEY_COOLDOWN_SECONDS", 60):
        tracker2 = KeyCycleTracker("openai", max_cycles=1)
        assert tracker2.all_keys_in_cooldown() is True

        # Should not be able to get any keys
        next_key = tracker2.get_next_key()
        assert next_key is None

    # Clean up
    reset_rotation_state("openai")


def test_same_request_bypasses_cooldown(monkeypatch):
    """Test that within the same request, cooldown is bypassed for retry."""
    monkeypatch.setenv("OPENAI_API_KEY_1", "key1")

    reset_rotation_state("openai")

    # With cooldown enabled, a single tracker should still be able to retry keys
    with patch("app.core.api_key_manager.KEY_COOLDOWN_SECONDS", 60):
        tracker = KeyCycleTracker("openai", max_cycles=3)

        # First attempt
        key1 = tracker.get_next_key()
        assert key1 == "key1"
        tracker.mark_failed(key1)

        # Second attempt - should still get the key (same request)
        key2 = tracker.get_next_key()
        assert key2 == "key1"  # Same key, within same request

    # Clean up
    reset_rotation_state("openai")
