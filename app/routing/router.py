"""
Core fallback router implementation.
Handles multi-level routing with API key, provider, and logical model fallbacks.
Enhanced with RouteExecutor integration and streaming support.
"""

import asyncio
import json
import logging
import os
from typing import Any, AsyncGenerator, Callable, Dict, List, Literal, Optional

import aiohttp

from app.core.api_key_manager import (
    KeyCycleTracker,
    get_available_keys,
)
from app.core.provider_config import get_provider_wire_protocol
from app.routing.config_loader import config_loader
from app.routing.executor import RouteExecutionError, RouteExecutor, get_executor
from app.routing.models import Attempt, ResolvedRoute, RoutingError

logger = logging.getLogger("fallback_router")

# Verbose error logging (shows full error body)
VERBOSE_HTTP_ERRORS = os.getenv("VERBOSE_HTTP_ERRORS", "false").lower() == "true"


def _format_error_for_log(
    error: Exception,
    provider: str,
    model: str,
    api_key: Optional[str] = None,
) -> str:
    """
    Format an error for logging, with concise or verbose output.

    For 401 errors, includes last 4 chars of API key for debugging.
    Verbose mode (VERBOSE_HTTP_ERRORS=true) shows full error body.

    Args:
        error: The exception that occurred
        provider: Provider name
        model: Model name
        api_key: Optional API key (last 4 chars shown for 401 errors)

    Returns:
        Formatted error string for logging
    """
    status_code = None
    error_code = None

    # Extract status code from various error types
    if hasattr(error, "status"):
        status_code = error.status
    elif hasattr(error, "status_code"):
        status_code = error.status_code

    # Try to extract error code from body for concise display
    if hasattr(error, "body") and error.body:
        try:
            body_json = json.loads(error.body)
            # Handle list responses (e.g., from Gemini: [{"error": {...}}])
            if isinstance(body_json, list) and body_json:
                body_json = body_json[0]
            if isinstance(body_json, dict):
                error_code = body_json.get("code") or body_json.get("type")
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass

    # Build concise error message
    parts = [f"provider={provider}", f"model={model}"]

    if status_code:
        parts.append(f"status={status_code}")

    # For 401 errors, show last 4 chars of API key
    if status_code == 401 and api_key:
        key_hint = f"...{api_key[-4:]}" if len(api_key) >= 4 else "***"
        parts.append(f"key={key_hint}")

    if error_code:
        parts.append(f"code={error_code}")

    base_msg = ", ".join(parts)

    # Verbose mode: include full error
    if VERBOSE_HTTP_ERRORS:
        return f"{base_msg}, error={str(error)}"

    return base_msg


# Type alias for wire protocols
WireProtocol = Literal["openai", "anthropic"]


class FallbackRouter:
    """
    Router that implements multi-level fallback logic.

    Supports three levels of fallback:
    1. API key fallback - try different API keys for the same provider/model
    2. Provider fallback - try different providers for the same logical model
    3. Model fallback - try different logical models entirely

    Uses RouteExecutor for actual route execution with protocol conversion.
    """

    def __init__(self, executor: Optional[RouteExecutor] = None):
        """
        Initialize the FallbackRouter.

        Args:
            executor: Optional RouteExecutor instance (uses singleton if not provided)
        """
        self._visited_models: set[str] = set()  # Track visited models to prevent cycles
        self._executor = executor or get_executor()

    async def call_with_fallback(
        self,
        logical_model: str,
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
        stream: bool = False,
        max_key_cycles: Optional[int] = None,
    ) -> Any:
        """
        Execute a request with full fallback routing.

        This method uses KeyCycleTracker for each provider to implement
        round-robin key selection with configurable cycle limits.

        Args:
            logical_model: The logical model name (e.g., 'glm-4.6')
            request_data: Request payload in target_protocol format
            target_protocol: The protocol the client expects ("openai" or "anthropic")
            stream: Whether to return a streaming response
            max_key_cycles: Maximum cycles through all keys per provider before
                           falling back to next provider. Defaults to MAX_KEY_RETRY_CYCLES.

        Returns:
            For non-streaming: Response dictionary in target_protocol format
            For streaming: AsyncGenerator yielding SSE chunks

        Raises:
            RoutingError: If all routes fail
        """
        # Collect route configs from model and its fallbacks
        route_configs = self._collect_route_configs(logical_model)

        if not route_configs:
            raise RoutingError(
                logical_model=logical_model,
                attempted_routes=[],
                errors=[
                    {"error": "No routes available", "error_type": "NoRoutesError"}
                ],
                message=f"No routes available for logical model '{logical_model}'",
            )

        errors = []
        all_attempts = []  # Track all attempts for error reporting
        attempt_number = 1

        if stream:
            return self._stream_with_fallback_dynamic(
                route_configs=route_configs,
                request_data=request_data,
                target_protocol=target_protocol,
                logical_model=logical_model,
                max_key_cycles=max_key_cycles,
            )

        # Non-streaming: iterate through route configs with KeyCycleTracker
        for route_config, is_fallback, source_model in route_configs:
            tracker = KeyCycleTracker(
                route_config.provider,
                max_cycles=max_key_cycles,
            )

            # Skip provider if all keys are in cooldown from previous failures
            if tracker.all_keys_in_cooldown():
                logger.info(
                    f"Skipping provider {route_config.provider}: "
                    f"all {tracker.total_keys} keys are in cooldown"
                )
                continue

            while not tracker.exhausted():
                api_key = tracker.get_next_key()
                if api_key is None:
                    break  # No more keys available for this provider

                resolved_route = self._build_resolved_route(
                    route_config=route_config,
                    source_logical_model=source_model,
                    api_key=api_key,
                )

                attempt = Attempt(
                    route=resolved_route,
                    attempt_number=attempt_number,
                    is_fallback_route=is_fallback,
                )
                all_attempts.append(attempt)

                logger.info(
                    f"Attempting route {attempt_number}: "
                    f"provider={resolved_route.provider}, model={resolved_route.model}, "
                    f"is_fallback={is_fallback}, cycle={tracker.current_cycle}"
                )

                try:
                    result = await self._executor.execute(
                        route=resolved_route,
                        request_data=request_data,
                        target_protocol=target_protocol,
                    )
                    logger.info(
                        f"Route succeeded: provider={resolved_route.provider}, "
                        f"model={resolved_route.model}"
                    )
                    return result

                except Exception as e:
                    tracker.mark_failed(api_key)

                    error_info = {
                        "attempt": attempt_number,
                        "provider": resolved_route.provider,
                        "model": resolved_route.model,
                        "route_id": resolved_route.route_id,
                        "error": str(e),
                        "error_type": type(e).__name__,
                    }

                    if self._is_fallback_worthy_error(e):
                        err_msg = _format_error_for_log(
                            e,
                            resolved_route.provider,
                            resolved_route.model,
                            api_key=resolved_route.api_key,
                        )
                        logger.warning(f"Route failed (fallback): {err_msg}")
                        errors.append(error_info)
                        attempt_number += 1
                        continue
                    else:
                        err_msg = _format_error_for_log(
                            e,
                            resolved_route.provider,
                            resolved_route.model,
                            api_key=resolved_route.api_key,
                        )
                        logger.error(f"Route failed (non-recoverable): {err_msg}")
                        raise

                attempt_number += 1

        # All providers exhausted
        error_message = self._format_routing_error_message(
            logical_model, all_attempts, errors
        )
        logger.error(
            f"All routes failed for '{logical_model}': {len(errors)} attempts failed"
        )

        raise RoutingError(
            logical_model=logical_model,
            attempted_routes=all_attempts,
            errors=errors,
            message=error_message,
        )

    def _collect_route_configs(self, logical_model: str) -> List[tuple]:
        """
        Collect all route configs from a model and its fallbacks.

        Returns:
            List of tuples: (RouteConfig, is_fallback: bool, source_model: str)
        """
        self._visited_models.clear()
        return self._collect_route_configs_recursive(logical_model, is_fallback=False)

    def _collect_route_configs_recursive(
        self,
        logical_model: str,
        is_fallback: bool = False,
    ) -> List[tuple]:
        """
        Recursively collect route configs, including fallback models.
        """
        if logical_model in self._visited_models:
            logger.debug(f"Skipping already-visited model: {logical_model}")
            return []

        self._visited_models.add(logical_model)

        try:
            config = config_loader.load_config(logical_model)
        except Exception as e:
            logger.warning(f"Failed to load config for '{logical_model}': {e}")
            self._visited_models.discard(logical_model)
            return []

        routes = []

        # Add routes from this model
        for route_config in config.model_routings:
            routes.append((route_config, is_fallback, logical_model))

        # Recursively add routes from fallback models
        for fallback_model in config.fallback_model_routings:
            fallback_routes = self._collect_route_configs_recursive(
                fallback_model, is_fallback=True
            )
            routes.extend(fallback_routes)

        self._visited_models.discard(logical_model)
        return routes

    def _build_resolved_route(
        self,
        route_config,
        source_logical_model: str,
        api_key: str,
    ) -> ResolvedRoute:
        """
        Build a ResolvedRoute from a route config and API key.
        """
        wire_protocol = route_config.wire_protocol or get_provider_wire_protocol(
            route_config.provider
        )
        return ResolvedRoute(
            source_logical_model=source_logical_model,
            wire_protocol=wire_protocol,
            provider=route_config.provider,
            model=route_config.model,
            base_url=route_config.base_url,
            api_key=api_key,
            timeout_seconds=route_config.timeout_seconds or 60,
            route_id=route_config.id,
        )

    # Legacy method - keep for backward compatibility with resolve_attempts
    async def _call_with_fallback_legacy(
        self,
        logical_model: str,
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
        stream: bool = False,
    ) -> Any:
        """Legacy implementation using pre-computed attempts."""
        attempts = self.resolve_attempts(logical_model)

        if not attempts:
            raise RoutingError(
                logical_model=logical_model,
                attempted_routes=[],
                errors=[
                    {"error": "No routes available", "error_type": "NoRoutesError"}
                ],
                message=f"No routes available for logical model '{logical_model}'",
            )

        errors = []

        if stream:
            # For streaming, return a generator that handles fallback internally
            return self._stream_with_fallback(
                attempts=attempts,
                request_data=request_data,
                target_protocol=target_protocol,
                logical_model=logical_model,
            )

        # Non-streaming request - try each attempt
        for attempt in attempts:
            logger.info(
                f"Attempting route {attempt.attempt_number}: "
                f"provider={attempt.route.provider}, model={attempt.route.model}, "
                f"is_fallback={attempt.is_fallback_route}"
            )

            try:
                result = await self._executor.execute(
                    route=attempt.route,
                    request_data=request_data,
                    target_protocol=target_protocol,
                )
                logger.info(
                    f"Route succeeded: provider={attempt.route.provider}, "
                    f"model={attempt.route.model}"
                )
                return result

            except Exception as e:
                error_info = {
                    "attempt": attempt.attempt_number,
                    "provider": attempt.route.provider,
                    "model": attempt.route.model,
                    "route_id": attempt.route.route_id,
                    "error": str(e),
                    "error_type": type(e).__name__,
                }

                # Check if this is a fallback-worthy error
                if self._is_fallback_worthy_error(e):
                    err_msg = _format_error_for_log(
                        e,
                        attempt.route.provider,
                        attempt.route.model,
                        api_key=attempt.route.api_key,
                    )
                    logger.warning(f"Route failed (fallback): {err_msg}")
                    errors.append(error_info)
                    continue
                else:
                    # Non-fallback error, re-raise immediately
                    err_msg = _format_error_for_log(
                        e,
                        attempt.route.provider,
                        attempt.route.model,
                        api_key=attempt.route.api_key,
                    )
                    logger.error(f"Route failed (non-recoverable): {err_msg}")
                    raise

        # All attempts failed
        error_message = self._format_routing_error_message(
            logical_model, attempts, errors
        )
        logger.error(f"All routes failed for '{logical_model}': {len(errors)} attempts")

        raise RoutingError(
            logical_model=logical_model,
            attempted_routes=attempts,
            errors=errors,
            message=error_message,
        )

    async def _stream_with_fallback_dynamic(
        self,
        route_configs: List[tuple],
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
        logical_model: str,
        max_key_cycles: Optional[int] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Execute streaming request with dynamic key selection and fallback support.

        Uses KeyCycleTracker for each provider to implement round-robin
        key selection with configurable cycle limits.
        """
        errors = []
        all_attempts = []
        attempt_number = 1

        for route_config, is_fallback, source_model in route_configs:
            tracker = KeyCycleTracker(
                route_config.provider,
                max_cycles=max_key_cycles,
            )

            # Skip provider if all keys are in cooldown from previous failures
            if tracker.all_keys_in_cooldown():
                logger.info(
                    f"Skipping provider {route_config.provider}: "
                    f"all {tracker.total_keys} keys are in cooldown"
                )
                continue

            while not tracker.exhausted():
                api_key = tracker.get_next_key()
                if api_key is None:
                    break  # No more keys available for this provider

                resolved_route = self._build_resolved_route(
                    route_config=route_config,
                    source_logical_model=source_model,
                    api_key=api_key,
                )

                attempt = Attempt(
                    route=resolved_route,
                    attempt_number=attempt_number,
                    is_fallback_route=is_fallback,
                )
                all_attempts.append(attempt)

                logger.info(
                    f"Attempting streaming route {attempt_number}: "
                    f"provider={resolved_route.provider}, model={resolved_route.model}, "
                    f"is_fallback={is_fallback}, cycle={tracker.current_cycle}"
                )

                try:
                    stream_gen = self._executor.execute_stream(
                        route=resolved_route,
                        request_data=request_data,
                        target_protocol=target_protocol,
                    )

                    async for chunk in stream_gen:
                        yield chunk

                    logger.info(
                        f"Streaming route completed: provider={resolved_route.provider}, "
                        f"model={resolved_route.model}"
                    )
                    return  # Success!

                except Exception as e:
                    tracker.mark_failed(api_key)

                    error_info = {
                        "attempt": attempt_number,
                        "provider": resolved_route.provider,
                        "model": resolved_route.model,
                        "route_id": resolved_route.route_id,
                        "error": str(e),
                        "error_type": type(e).__name__,
                    }

                    if self._is_fallback_worthy_error(e):
                        err_msg = _format_error_for_log(
                            e,
                            resolved_route.provider,
                            resolved_route.model,
                            api_key=api_key,
                        )
                        logger.warning(f"Stream failed (fallback): {err_msg}")
                        errors.append(error_info)
                        attempt_number += 1
                        continue
                    else:
                        err_msg = _format_error_for_log(
                            e,
                            resolved_route.provider,
                            resolved_route.model,
                            api_key=api_key,
                        )
                        logger.error(f"Stream failed (non-recoverable): {err_msg}")
                        raise

                attempt_number += 1

        # All providers exhausted
        error_message = self._format_routing_error_message(
            logical_model, all_attempts, errors
        )
        logger.error(f"All routes failed for '{logical_model}': {len(errors)} attempts")

        raise RoutingError(
            logical_model=logical_model,
            attempted_routes=all_attempts,
            errors=errors,
            message=error_message,
        )

    async def _stream_with_fallback(
        self,
        attempts: List[Attempt],
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
        logical_model: str,
    ) -> AsyncGenerator[str, None]:
        """
        Legacy streaming implementation using pre-computed attempts.

        Kept for backward compatibility with resolve_attempts().
        """
        errors = []

        for attempt in attempts:
            logger.info(
                f"Attempting streaming route {attempt.attempt_number}: "
                f"provider={attempt.route.provider}, model={attempt.route.model}, "
                f"is_fallback={attempt.is_fallback_route}"
            )

            try:
                # Get the stream generator
                stream_gen = self._executor.execute_stream(
                    route=attempt.route,
                    request_data=request_data,
                    target_protocol=target_protocol,
                )

                async for chunk in stream_gen:
                    yield chunk

                # Stream completed successfully
                logger.info(
                    f"Streaming route completed: provider={attempt.route.provider}, "
                    f"model={attempt.route.model}"
                )
                return  # Exit the generator

            except Exception as e:
                error_info = {
                    "attempt": attempt.attempt_number,
                    "provider": attempt.route.provider,
                    "model": attempt.route.model,
                    "route_id": attempt.route.route_id,
                    "error": str(e),
                    "error_type": type(e).__name__,
                }

                # Check if this is a fallback-worthy error
                if self._is_fallback_worthy_error(e):
                    err_msg = _format_error_for_log(
                        e,
                        attempt.route.provider,
                        attempt.route.model,
                        api_key=attempt.route.api_key,
                    )
                    logger.warning(f"Stream failed (fallback): {err_msg}")
                    errors.append(error_info)
                    continue  # Try next attempt
                else:
                    # Non-fallback error, re-raise
                    err_msg = _format_error_for_log(
                        e,
                        attempt.route.provider,
                        attempt.route.model,
                        api_key=attempt.route.api_key,
                    )
                    logger.error(f"Stream failed (non-recoverable): {err_msg}")
                    raise

        # All attempts failed
        error_message = self._format_routing_error_message(
            logical_model, attempts, errors
        )
        logger.error(f"All routes failed for '{logical_model}': {len(errors)} attempts")

        raise RoutingError(
            logical_model=logical_model,
            attempted_routes=attempts,
            errors=errors,
            message=error_message,
        )

    def resolve_attempts(self, logical_model: str) -> List[Attempt]:
        """
        Resolve all possible attempts for a logical model, including fallbacks.

        This builds an ordered list of all routes to try, including:
        - All API keys for each provider route in the model config
        - Routes from fallback logical models

        Returns:
            Ordered list of Attempt objects to try in sequence
        """
        self._visited_models.clear()
        return self._resolve_attempts_recursive(logical_model, is_fallback=False)

    def _resolve_attempts_recursive(
        self, logical_model: str, is_fallback: bool = False
    ) -> List[Attempt]:
        """
        Recursively resolve attempts, including fallback logical models.

        Args:
            logical_model: Model name to resolve
            is_fallback: Whether this is a fallback model (affects logging/tracking)

        Returns:
            List of Attempt objects
        """
        # Cycle detection
        if logical_model in self._visited_models:
            logger.debug(f"Skipping already-visited model: {logical_model}")
            return []

        self._visited_models.add(logical_model)

        try:
            config = config_loader.load_config(logical_model)
        except Exception as e:
            logger.warning(f"Failed to load config for '{logical_model}': {e}")
            self._visited_models.discard(logical_model)
            return []

        attempts = []
        attempt_number = 1

        # First, add attempts from this model's routes
        for route_config in config.model_routings:
            route_attempts = self._expand_route_to_attempts(
                route_config=route_config,
                source_logical_model=logical_model,
                default_timeout=config.timeout_seconds or 60,
                start_attempt_number=attempt_number,
                is_fallback_route=is_fallback,
            )
            attempts.extend(route_attempts)
            attempt_number += len(route_attempts)

        # Then recursively add attempts from fallback models
        for fallback_model in config.fallback_model_routings:
            fallback_attempts = self._resolve_attempts_recursive(
                fallback_model, is_fallback=True
            )
            # Renumber the fallback attempts
            for attempt in fallback_attempts:
                attempt.attempt_number = attempt_number
                attempt_number += 1
            attempts.extend(fallback_attempts)

        self._visited_models.discard(logical_model)
        return attempts

    def _expand_route_to_attempts(
        self,
        route_config,
        source_logical_model: str,
        default_timeout: int,
        start_attempt_number: int,
        is_fallback_route: bool,
    ) -> List[Attempt]:
        """
        Expand a single route config into multiple attempts (one per API key).

        Each API key in the route config becomes a separate attempt,
        allowing for API key-level fallback.

        Args:
            route_config: The route configuration
            source_logical_model: The logical model this route belongs to
            default_timeout: Default timeout if not specified in route
            start_attempt_number: Starting attempt number for this batch
            is_fallback_route: Whether this is from a fallback model

        Returns:
            List of Attempt objects, one per available API key
        """
        attempts = []
        attempt_offset = 0

        wire_protocol = route_config.wire_protocol or get_provider_wire_protocol(
            route_config.provider
        )

        if route_config.api_key_env:
            api_keys = []
            for api_key_env in route_config.api_key_env:
                api_key = os.getenv(api_key_env)
                if not api_key:
                    logger.debug(f"API key not found in env var: {api_key_env}")
                    continue
                api_keys.append(api_key)
        else:
            api_keys = get_available_keys(route_config.provider)

        for api_key in api_keys:
            resolved_route = ResolvedRoute(
                source_logical_model=source_logical_model,
                wire_protocol=wire_protocol,
                provider=route_config.provider,
                model=route_config.model,
                base_url=route_config.base_url,
                api_key=api_key,
                timeout_seconds=route_config.timeout_seconds or default_timeout,
                route_id=route_config.id,
            )

            attempt = Attempt(
                route=resolved_route,
                attempt_number=start_attempt_number + attempt_offset,
                is_fallback_route=is_fallback_route,
            )

            attempts.append(attempt)
            attempt_offset += 1

        return attempts

    def _is_fallback_worthy_error(self, error: BaseException) -> bool:
        """
        Determine if an error should trigger fallback to the next route.

        Fallback-worthy errors include:
        - HTTP 4xx/5xx status codes (except 401/403 which are permanent auth issues)
        - Network errors (connection, DNS, timeout, etc.)
        - Rate limiting (429)
        - Provider-specific transient errors

        Args:
            error: The exception to evaluate

        Returns:
            True if fallback should be attempted, False if error is permanent
        """
        # Check for HTTP status errors
        if hasattr(error, "status"):
            status = error.status
            if status is not None:
                # 401/403 are auth errors - likely permanent issues with this key
                # Don't fallback to same provider with different key for auth errors
                if status in (401, 403):
                    return True  # Still allow fallback to different provider/key
                # Other 4xx and 5xx errors are fallback-worthy
                if 400 <= status < 600:
                    return True

        # Check for RouteExecutionError
        if isinstance(error, RouteExecutionError):
            if error.status_code:
                return 400 <= error.status_code < 600
            return True  # Default to allowing fallback for execution errors

        # Check for aiohttp client errors (network issues)
        if isinstance(
            error,
            (aiohttp.ClientError, aiohttp.ServerTimeoutError, asyncio.TimeoutError),
        ):
            return True

        # Check for httpx timeout errors
        try:
            import httpx

            if isinstance(error, (httpx.TimeoutException, httpx.ConnectError)):
                return True
        except ImportError:
            pass

        # Check error message for transient indicators
        error_msg = str(error).lower()
        transient_indicators = [
            "timeout",
            "connection",
            "network",
            "unreachable",
            "reset",
            "server error",
            "internal server error",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
            "too many requests",
            "rate limit",
            "temporarily",
            "overloaded",
            "capacity",
        ]

        return any(indicator in error_msg for indicator in transient_indicators)

    def _format_routing_error_message(
        self,
        logical_model: str,
        attempts: List[Attempt],
        errors: List[Dict[str, Any]],
    ) -> str:
        """
        Format a human-readable error message for routing failures.

        Args:
            logical_model: The logical model that was requested
            attempts: List of all attempts made
            errors: List of error details from failed attempts

        Returns:
            Formatted error message
        """
        parts = [f"All routes failed for logical model '{logical_model}'"]

        if not attempts:
            parts.append("No routes were available to try.")
        else:
            parts.append(f"Attempted {len(attempts)} route(s):")

            # Create error lookup by attempt number
            error_by_attempt = {e.get("attempt"): e for e in errors}

            for attempt in attempts:
                route = attempt.route
                error_info = error_by_attempt.get(attempt.attempt_number, {})
                error_msg = error_info.get("error", "Unknown error")
                error_type = error_info.get("error_type", "Unknown")

                fallback_marker = " [FALLBACK]" if attempt.is_fallback_route else ""
                status = (
                    f"FAILED ({error_type}: {error_msg[:80]}...)"
                    if len(error_msg) > 80
                    else f"FAILED ({error_type}: {error_msg})"
                )

                parts.append(
                    f"  {attempt.attempt_number}. {route.provider}/{route.model} "
                    f"({route.wire_protocol}){fallback_marker} - {status}"
                )

        return "\n".join(parts)


# Convenience functions for easy access


async def call_with_fallback(
    logical_model: str,
    request_data: Dict[str, Any],
    target_protocol: WireProtocol,
    stream: bool = False,
    max_key_cycles: Optional[int] = None,
) -> Any:
    """
    Convenience function to call with fallback routing.

    Creates a new FallbackRouter instance and executes the request.

    Args:
        logical_model: The logical model name
        request_data: Request payload in target_protocol format
        target_protocol: Expected response protocol ("openai" or "anthropic")
        stream: Whether to return a streaming response
        max_key_cycles: Maximum cycles through all keys per provider before
                       falling back to next provider. Defaults to MAX_KEY_RETRY_CYCLES.

    Returns:
        Response data or async generator for streaming
    """
    router = FallbackRouter()
    return await router.call_with_fallback(
        logical_model=logical_model,
        request_data=request_data,
        target_protocol=target_protocol,
        stream=stream,
        max_key_cycles=max_key_cycles,
    )


async def call_with_fallback_legacy(
    logical_model: str, exec_route_fn: Callable[[ResolvedRoute], Any]
) -> Any:
    """
    Legacy convenience function for backward compatibility.

    This maintains the old interface where a custom execution function is provided.
    Prefer using call_with_fallback() with the new interface.

    Args:
        logical_model: The logical model name to resolve
        exec_route_fn: Function to execute a resolved route, should return response or raise

    Returns:
        The successful response from the first working route

    Raises:
        RoutingError: If all routes fail
    """
    router = FallbackRouter()
    attempts = router.resolve_attempts(logical_model)

    errors = []
    for attempt in attempts:
        try:
            result = await exec_route_fn(attempt.route)
            return result
        except Exception as e:
            if router._is_fallback_worthy_error(e):
                errors.append(
                    {
                        "attempt": attempt.attempt_number,
                        "error": str(e),
                        "error_type": type(e).__name__,
                    }
                )
                continue
            else:
                raise

    raise RoutingError(
        logical_model=logical_model,
        attempted_routes=attempts,
        errors=errors,
        message=router._format_routing_error_message(logical_model, attempts, errors),
    )
