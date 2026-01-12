"""
API Key Manager for handling multiple API keys per provider with fallback.
Parses environment variables and manages key rotation with circuit breaker pattern.
Uses provider configuration for environment variable patterns.

Supports round-robin key selection and per-request cycle tracking for robust
fallback behavior across multiple API keys and providers.

Enhanced with scoped failures to distinguish between provider-wide failures
(e.g., 401 Unauthorized) and model-specific failures (e.g., 429 Rate Limit).
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
KEY_COOLDOWN_SECONDS = int(os.getenv("KEY_COOLDOWN_SECONDS", "180"))

# Maximum retry cycles through all keys before falling back to next provider
MAX_KEY_RETRY_CYCLES = int(os.getenv("MAX_KEY_RETRY_CYCLES", "1"))


@dataclass
class KeyRotationState:
    """Tracks per-provider key rotation state (global, persists across requests)."""

    last_used_index: int = -1
    # Global failures: {key: (timestamp, cooldown_duration)}
    failed_keys: Dict[str, Tuple[float, int]] = field(default_factory=dict)
    # Unified model-scoped failures: {provider/model: {key: (timestamp, cooldown_duration)}}
    model_failed_keys: Dict[str, Dict[str, Tuple[float, int]]] = field(
        default_factory=lambda: defaultdict(dict)
    )
    # Provider-wide failure (all keys): {provider: timestamp_until}
    provider_failed_until: float = 0


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

    Supports scoped failures to distinguish between model-specific limits (429s)
    and provider-wide failures (401s).
    """

    def __init__(
        self,
        provider: str,
        model: Optional[str] = None,
        max_cycles: Optional[int] = None,
        provider_cooldown: Optional[int] = None,
        route_cooldown: Optional[int] = None,
    ):
        """
        Initialize tracker for a specific provider and optional model context.

        Args:
            provider: Provider name (e.g., "openai", "cerebras")
            model: Optional model name for scoped failure tracking
            max_cycles: Maximum cycles through all keys before exhaustion.
                        Defaults to MAX_KEY_RETRY_CYCLES env setting.
            provider_cooldown: Optional custom cooldown for provider-wide failures
            route_cooldown: Optional custom cooldown for model-specific failures
        """
        self.provider = provider
        self.model = model
        self.max_cycles = max_cycles if max_cycles is not None else MAX_KEY_RETRY_CYCLES
        self.provider_cooldown = provider_cooldown or KEY_COOLDOWN_SECONDS
        self.route_cooldown = route_cooldown or self.provider_cooldown
        self.current_cycle = 0
        self.keys_tried_this_cycle: Set[str] = set()
        self._keys_attempted: Set[str] = set()  # All keys attempted by this tracker
        self._all_keys = _parse_provider_keys(provider)
        self._key_index = _rotation_state[provider].last_used_index
        # Unified route key for cross-logical-model cooldown unification
        self.route_key = f"{provider}/{model}" if model else provider

    def get_next_key(self) -> Optional[str]:
        """
        Get the next key to try using round-robin selection.

        Returns None if:
        - No keys available for this provider
        - All cycles exhausted (max_cycles reached)
        - All keys in current cycle failed and cooldown not expired
        - Provider is in provider-wide cooldown

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

        # Check provider-wide cooldown
        if state.provider_failed_until > current_time:
            logger.info(f"Provider {self.provider} is in provider-wide cooldown")
            return None

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
                # 1. Check Global/Provider Failures
                fail_info = state.failed_keys.get(candidate)
                if fail_info:
                    fail_time, cooldown_duration = fail_info
                    if (current_time - fail_time) < cooldown_duration:
                        continue  # Still in global cooldown

                # 2. Check Unified Model-Scoped Failures (if model context available)
                if self.model:
                    model_fails = state.model_failed_keys.get(self.route_key, {})
                    fail_info = model_fails.get(candidate)
                    if fail_info:
                        fail_time, cooldown_duration = fail_info
                        if (current_time - fail_time) < cooldown_duration:
                            continue  # Still in model-scoped cooldown

            # Key is available
            self.keys_tried_this_cycle.add(candidate)
            self._keys_attempted.add(candidate)
            state.last_used_index = self._key_index
            key_hint = f"...{candidate[-4:]}" if len(candidate) >= 4 else "****"
            logger.info(
                f"Using API key {key_hint} for {self.provider} (model: {self.model or 'N/A'})"
            )
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
        logger.debug(
            f"Cycle reset for provider {self.provider}: "
            f"now on cycle {self.current_cycle}/{self.max_cycles}"
        )

    def all_keys_in_cooldown(self) -> bool:
        """
        Check if ALL keys for this provider/model combo are currently in cooldown.

        Returns:
            True if all keys are in cooldown and should be skipped
        """
        if not self._all_keys:
            return True

        state = _rotation_state[self.provider]
        current_time = time.time()

        # Check provider-wide cooldown
        if state.provider_failed_until > current_time:
            return True

        for key in self._all_keys:
            # A key is available if it's NOT in global cooldown AND (NOT in model cooldown)
            fail_info = state.failed_keys.get(key)
            if fail_info:
                fail_time, cooldown_duration = fail_info
                if (current_time - fail_time) < cooldown_duration:
                    continue  # In global cooldown

            # Key is not in global cooldown. Now check model cooldown.
            if self.model:
                model_fail_info = state.model_failed_keys.get(self.route_key, {}).get(
                    key
                )
                if model_fail_info:
                    fail_time, cooldown_duration = model_fail_info
                    if (current_time - fail_time) < cooldown_duration:
                        continue  # In model-scoped cooldown

            return False  # Found at least one available key

        return True  # All keys are blocked either globally or for this model

    def mark_failed(
        self,
        key: str,
        action: str = "model_key_failure",
        is_global: Optional[bool] = None,
        cooldown_duration: Optional[int] = None,
    ) -> None:
        """
        Mark key or provider as failed (updates state).

        Args:
            key: The API key that failed
            action: The action to take (model_key_failure, global_key_failure, provider_cooldown)
            is_global: For backward compatibility. If True, maps to global_key_failure.
            cooldown_duration: Optional custom cooldown duration.
        """
        # Handle backward compatibility
        effective_action = action
        if is_global is True:
            effective_action = "global_key_failure"
        elif is_global is False:
            effective_action = "model_key_failure"

        key_hint = f"...{key[-4:]}" if len(key) >= 4 else "****"
        logger.warning(
            f"API key {key_hint} failed (action: {effective_action}) for {self.provider}"
        )

        duration = cooldown_duration
        if duration is None:
            if effective_action == "model_key_failure":
                duration = self.route_cooldown
            else:
                duration = self.provider_cooldown

        if effective_action == "provider_cooldown":
            mark_provider_failed(self.provider, duration)
        elif effective_action == "global_key_failure":
            mark_key_failed(self.provider, key, cooldown_duration=duration)
        else:  # model_key_failure
            mark_key_failed(
                self.provider, key, model=self.route_key, cooldown_duration=duration
            )

    def exhausted(self) -> bool:
        """Check if all cycles are exhausted."""
        if not self._all_keys:
            return True
        if self.current_cycle >= self.max_cycles:
            return True
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
    """Get list of all parsed keys for a provider."""
    return _parse_provider_keys(provider)


def get_api_key(provider: str, model: Optional[str] = None) -> Optional[str]:
    """
    Get an available API key for a provider using round-robin selection.

    Args:
        provider: Provider name
        model: Optional model for scoped cooldown check

    Returns:
        API key string, or None if no keys available
    """
    all_keys = _parse_provider_keys(provider)
    if not all_keys:
        return None

    state = _rotation_state[provider]
    current_time = time.time()

    # Check provider-wide cooldown
    if state.provider_failed_until > current_time:
        return None

    num_keys = len(all_keys)
    route_key = f"{provider}/{model}" if model else provider

    for offset in range(num_keys):
        next_index = (state.last_used_index + 1 + offset) % num_keys
        candidate_key = all_keys[next_index]

        # 1. Check global cooldown
        fail_info = state.failed_keys.get(candidate_key)
        if fail_info:
            fail_time, cooldown_duration = fail_info
            if (current_time - fail_time) < cooldown_duration:
                continue

        # 2. Check model-scoped cooldown
        if model:
            model_fails = state.model_failed_keys.get(route_key, {})
            fail_info = model_fails.get(candidate_key)
            if fail_info:
                fail_time, cooldown_duration = fail_info
                if (current_time - fail_time) < cooldown_duration:
                    continue

        state.last_used_index = next_index
        return candidate_key

    return None


def mark_key_failed(
    provider: str, key: str, model: Optional[str] = None, cooldown_duration: int = 180
) -> None:
    """
    Mark an API key as failed.

    Args:
        provider: Provider name
        key: The failed API key
        model: If provided, failure is scoped to this model (provider/model).
               If None, failure is global for the provider (e.g. 401).
        cooldown_duration: Duration in seconds for the cooldown.
    """
    state = _rotation_state[provider]
    now = time.time()
    if model:
        state.model_failed_keys[model][key] = (now, cooldown_duration)
        logger.debug(
            f"Marked key failed for {provider} model {model} (duration: {cooldown_duration}s)"
        )
    else:
        state.failed_keys[key] = (now, cooldown_duration)
        logger.debug(
            f"Marked key failed globally for {provider} (duration: {cooldown_duration}s)"
        )


def mark_provider_failed(provider: str, cooldown_duration: int = 180) -> None:
    """
    Mark an entire provider as failed (provider-wide cooldown).

    Args:
        provider: Provider name
        cooldown_duration: Duration in seconds for the cooldown.
    """
    state = _rotation_state[provider]
    state.provider_failed_until = time.time() + cooldown_duration
    logger.warning(
        f"Marked provider {provider} failed for {cooldown_duration}s (provider-wide cooldown)"
    )


def get_all_keys(provider: str) -> List[str]:
    """Get all keys for a provider."""
    return _parse_provider_keys(provider)


def reset_failed_keys(provider: Optional[str] = None) -> None:
    """Reset failed keys for a provider (or all providers if None)."""
    if provider:
        if provider in _rotation_state:
            _rotation_state[provider].failed_keys.clear()
            _rotation_state[provider].model_failed_keys.clear()
            _rotation_state[provider].provider_failed_until = 0
    else:
        for state in _rotation_state.values():
            state.failed_keys.clear()
            state.model_failed_keys.clear()
            state.provider_failed_until = 0


def reset_rotation_state(provider: Optional[str] = None) -> None:
    """Reset all rotation state for a provider (or all providers if None)."""
    if provider:
        if provider in _rotation_state:
            _rotation_state[provider] = KeyRotationState()
    else:
        _rotation_state.clear()


def get_rotation_state(provider: str) -> KeyRotationState:
    """Get rotation state for a provider."""
    return _rotation_state[provider]
