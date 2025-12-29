"""
API Key Manager for handling multiple API keys per provider with fallback.
Parses environment variables and manages key rotation with circuit breaker pattern.
Uses provider configuration for environment variable patterns.

Supports round-robin key selection and per-request cycle tracking for robust
fallback behavior across multiple API keys and providers.
"""

import logging
import os
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from app.core.provider_config import get_provider_env_var_patterns

logger = logging.getLogger("api_key_manager")

# Cooldown period for failed keys before they re-enter rotation (can be overridden via env)
KEY_COOLDOWN_SECONDS = int(os.getenv("KEY_COOLDOWN_SECONDS", "60"))

# Maximum retry cycles through all keys before falling back to next provider
MAX_KEY_RETRY_CYCLES = int(os.getenv("MAX_KEY_RETRY_CYCLES", "1"))


@dataclass
class KeyRotationState:
    """Tracks per-provider key rotation state (global, persists across requests)."""

    last_used_index: int = -1
    failed_keys: Dict[str, float] = field(default_factory=dict)


# Global rotation state: {provider: KeyRotationState}
_rotation_state: Dict[str, KeyRotationState] = defaultdict(KeyRotationState)


def _parse_provider_keys(provider_name: str) -> List[str]:
    """
    Parse environment variables for a provider's API keys.
    Uses provider configuration to determine env var patterns.
    Falls back to default pattern if config not available.

    Args:
        provider_name: Provider name (e.g., "openai", "anthropic")

    Returns:
        List of API keys found
    """
    keys: List[str] = []
    seen = set()

    # Try to get patterns from provider config
    try:
        patterns = get_provider_env_var_patterns(provider_name)
    except Exception:
        # Fallback to default pattern if config not available
        patterns = []

    # If no patterns from config, use default pattern
    if not patterns:
        env_prefix = provider_name.upper().replace("-", "_")
        patterns = [f"{env_prefix}_API_KEY", f"{env_prefix}_API_KEY_{{INDEX}}"]

    def _add_key(value: Optional[str]) -> None:
        if value and value not in seen:
            keys.append(value)
            seen.add(value)

    def _collect_indexed(pattern_with_index: str) -> List[Tuple[int, str]]:
        escaped = re.escape(pattern_with_index)
        modified = escaped.replace(r"\{INDEX\}", r"(\d+)")
        regex = re.compile(rf"^{modified}$")
        matches: List[Tuple[int, str]] = []
        for env_var, value in os.environ.items():
            match = regex.match(env_var)
            if not match:
                continue
            try:
                index = int(match.group(1))
            except ValueError:
                continue
            matches.append((index, value))
        matches.sort(key=lambda item: item[0])
        return matches

    # Parse keys based on patterns
    for pattern in patterns:
        if "{INDEX}" in pattern:
            # Pattern with index placeholder (e.g., OPENAI_API_KEY_{INDEX})
            for _, value in _collect_indexed(pattern):
                _add_key(value)
        else:
            # Simple pattern without index (e.g., OPENAI_API_KEY)
            _add_key(os.getenv(pattern))

    return keys


class KeyCycleTracker:
    """
    Tracks key usage cycles for a single request.

    Provides round-robin key selection with configurable cycle limits.
    Keys re-enter rotation when either:
    - All keys in the cycle have been tried once (cycle reset within request)
    - The KEY_COOLDOWN_SECONDS expires (time-based re-entry across requests)

    Failed keys are preserved across requests to allow provider skipping when
    all keys are in cooldown.
    """

    def __init__(self, provider: str, max_cycles: Optional[int] = None):
        """
        Initialize tracker for a specific provider.

        Args:
            provider: Provider name (e.g., "openai", "cerebras")
            max_cycles: Maximum cycles through all keys before exhaustion.
                        Defaults to MAX_KEY_RETRY_CYCLES env setting.
        """
        self.provider = provider
        self.max_cycles = max_cycles if max_cycles is not None else MAX_KEY_RETRY_CYCLES
        self.current_cycle = 0
        self.keys_tried_this_cycle: Set[str] = set()
        self._keys_attempted: Set[str] = set()  # All keys attempted by this tracker
        self._all_keys = _parse_provider_keys(provider)
        self._key_index = _rotation_state[provider].last_used_index

    def get_next_key(self) -> Optional[str]:
        """
        Get the next key to try using round-robin selection.

        Returns None if:
        - No keys available for this provider
        - All cycles exhausted (max_cycles reached)
        - All keys in current cycle failed and cooldown not expired

        Within the same request, keys that have already been attempted by this
        tracker can be retried (cooldown check is bypassed). Across requests,
        cooldown is respected.

        Returns:
            API key string, or None if no key available
        """
        if not self._all_keys:
            return None

        if self.current_cycle >= self.max_cycles:
            return None

        state = _rotation_state[self.provider]
        current_time = time.time()
        num_keys = len(self._all_keys)

        # Try each key starting from current position
        for _ in range(num_keys):
            self._key_index = (self._key_index + 1) % num_keys
            candidate = self._all_keys[self._key_index]

            # Check if already tried this cycle
            if candidate in self.keys_tried_this_cycle:
                continue

            # Check global failure status and cooldown
            # BUT: bypass cooldown check if this tracker has already attempted the key
            # (allows retries within the same request)
            if candidate not in self._keys_attempted:
                fail_time = state.failed_keys.get(candidate)
                if fail_time is not None and KEY_COOLDOWN_SECONDS > 0:
                    if (current_time - fail_time) < KEY_COOLDOWN_SECONDS:
                        continue  # Still in cooldown from previous request

            # Key is available
            self.keys_tried_this_cycle.add(candidate)
            self._keys_attempted.add(candidate)
            state.last_used_index = self._key_index
            key_hint = f"...{candidate[-4:]}" if len(candidate) >= 4 else "****"
            logger.info(f"Using API key {key_hint} for {self.provider}")
            return candidate

        # All keys tried this cycle - check if we should start new cycle
        if self._should_reset_cycle():
            self._reset_cycle()
            return self.get_next_key()

        return None

    def _should_reset_cycle(self) -> bool:
        """Check if all keys have been tried at least once this cycle."""
        return len(self.keys_tried_this_cycle) >= len(self._all_keys)

    def _reset_cycle(self) -> None:
        """
        Reset for new cycle.

        Clears the per-cycle tracking but preserves global failed_keys
        to maintain cooldown state across requests.
        """
        self.current_cycle += 1
        self.keys_tried_this_cycle.clear()
        # NOTE: We do NOT clear _rotation_state[self.provider].failed_keys
        # This preserves failures across requests so providers with all keys
        # in cooldown can be skipped entirely.
        logger.debug(
            f"Cycle reset for provider {self.provider}: "
            f"now on cycle {self.current_cycle}/{self.max_cycles}"
        )

    def all_keys_in_cooldown(self) -> bool:
        """
        Check if ALL keys for this provider are currently in cooldown.

        This is used by the router to skip providers entirely when all
        keys have recently failed and are still in their cooldown period.

        Returns:
            True if all keys are in cooldown and should be skipped
        """
        if not self._all_keys:
            return True  # No keys = effectively unavailable

        if KEY_COOLDOWN_SECONDS <= 0:
            return False  # Cooldown disabled, keys always available

        state = _rotation_state[self.provider]
        current_time = time.time()

        for key in self._all_keys:
            fail_time = state.failed_keys.get(key)
            if fail_time is None:
                return False  # Key hasn't failed, not in cooldown
            if (current_time - fail_time) >= KEY_COOLDOWN_SECONDS:
                return False  # Cooldown expired for this key

        return True  # All keys are in cooldown

    def mark_failed(self, key: str) -> None:
        """
        Mark key as failed (updates global state).

        Args:
            key: The API key that failed
        """
        key_hint = f"...{key[-4:]}" if len(key) >= 4 else "****"
        logger.warning(
            f"API key {key_hint} failed for {self.provider}, trying next key"
        )
        mark_key_failed(self.provider, key)

    def exhausted(self) -> bool:
        """
        Check if all cycles are exhausted.

        Returns:
            True if no more keys can be tried (all cycles used up or no keys)
        """
        # No keys available
        if not self._all_keys:
            return True
        if self.current_cycle >= self.max_cycles:
            return True
        # Also exhausted if we've tried all keys and can't reset
        if self._should_reset_cycle() and self.current_cycle + 1 >= self.max_cycles:
            return True
        return False

    @property
    def cycles_remaining(self) -> int:
        """Return number of cycles remaining."""
        return max(0, self.max_cycles - self.current_cycle)

    @property
    def total_keys(self) -> int:
        """Return total number of keys for this provider."""
        return len(self._all_keys)


def get_available_keys(provider: str) -> List[str]:
    """
    Get list of available keys for a provider.
    Cooldown is disabled by default; returns all parsed keys.
    """
    return _parse_provider_keys(provider)


def get_api_key(provider: str) -> Optional[str]:
    """
    Get an available API key for a provider using round-robin selection.

    Skips keys that are currently in cooldown (if KEY_COOLDOWN_SECONDS > 0).

    Args:
        provider: Provider name

    Returns:
        API key string, or None if no keys available
    """
    all_keys = _parse_provider_keys(provider)
    if not all_keys:
        return None

    state = _rotation_state[provider]
    current_time = time.time()
    num_keys = len(all_keys)

    # Try each key starting from the one after last used
    for offset in range(num_keys):
        next_index = (state.last_used_index + 1 + offset) % num_keys
        candidate_key = all_keys[next_index]

        # Check if key is failed and still in cooldown
        fail_time = state.failed_keys.get(candidate_key)
        if fail_time is not None and KEY_COOLDOWN_SECONDS > 0:
            if (current_time - fail_time) < KEY_COOLDOWN_SECONDS:
                continue  # Skip, still in cooldown
            else:
                # Cooldown expired, clear failure
                del state.failed_keys[candidate_key]

        state.last_used_index = next_index
        return candidate_key

    # All keys failed and in cooldown
    return None


def mark_key_failed(provider: str, key: str) -> None:
    """
    Mark an API key as failed, excluding it from selection until cooldown expires.

    The key will be skipped in round-robin selection until:
    - KEY_COOLDOWN_SECONDS expires (time-based re-entry), OR
    - A KeyCycleTracker resets its cycle (all keys tried)

    Args:
        provider: Provider name
        key: The failed API key
    """
    state = _rotation_state[provider]
    state.failed_keys[key] = time.time()
    logger.debug(f"Marked key as failed for provider {provider}")


def get_all_keys(provider: str) -> List[str]:
    """
    Get all keys for a provider (including failed ones).

    Args:
        provider: Provider name

    Returns:
        List of all API keys
    """
    return _parse_provider_keys(provider)


def reset_failed_keys(provider: Optional[str] = None) -> None:
    """
    Reset failed keys for a provider (or all providers if None).
    Useful for testing or manual recovery.

    Args:
        provider: Provider name, or None to reset all
    """
    if provider:
        if provider in _rotation_state:
            _rotation_state[provider].failed_keys.clear()
    else:
        for state in _rotation_state.values():
            state.failed_keys.clear()


def reset_rotation_state(provider: Optional[str] = None) -> None:
    """
    Reset all rotation state for a provider (or all providers if None).
    Resets both failed keys and last_used_index.
    Useful for testing.

    Args:
        provider: Provider name, or None to reset all
    """
    if provider:
        if provider in _rotation_state:
            _rotation_state[provider] = KeyRotationState()
    else:
        _rotation_state.clear()


def get_rotation_state(provider: str) -> KeyRotationState:
    """
    Get the current rotation state for a provider.
    Useful for debugging and testing.

    Args:
        provider: Provider name

    Returns:
        KeyRotationState for the provider
    """
    return _rotation_state[provider]
