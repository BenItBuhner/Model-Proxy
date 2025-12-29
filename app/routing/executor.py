"""
Route Executor - Executes resolved routes with automatic protocol conversion.

This module provides the RouteExecutor class which handles:
- Executing resolved routes via appropriate providers
- Automatic request/response conversion between OpenAI and Anthropic protocols
- Streaming support with protocol conversion
- Consistent error handling and propagation
"""

import json
import logging
import os
from typing import Any, AsyncGenerator, Dict, Literal, Optional

from app.core.format_converters import (
    anthropic_to_openai_request,
    anthropic_to_openai_response,
    openai_to_anthropic_request,
    openai_to_anthropic_response,
)
from app.providers.registry import ProviderRegistry
from app.routing.models import ResolvedRoute

logger = logging.getLogger("route_executor")

# Verbose error logging (shows full error body)
VERBOSE_HTTP_ERRORS = os.getenv("VERBOSE_HTTP_ERRORS", "false").lower() == "true"


def _format_error(error: Exception, provider: str, model: str) -> str:
    """Format error concisely, or verbosely if VERBOSE_HTTP_ERRORS is set."""
    status_code = getattr(error, "status", None) or getattr(error, "status_code", None)
    error_code = None

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

    parts = [f"provider={provider}", f"model={model}"]
    if status_code:
        parts.append(f"status={status_code}")
    if error_code:
        parts.append(f"code={error_code}")

    base_msg = ", ".join(parts)
    if VERBOSE_HTTP_ERRORS:
        return f"{base_msg}, error={str(error)}"
    return base_msg


# Type alias for wire protocols
WireProtocol = Literal["openai", "anthropic"]


class RouteExecutionError(Exception):
    """Exception raised when route execution fails."""

    def __init__(
        self,
        message: str,
        route: ResolvedRoute,
        original_error: Optional[Exception] = None,
        status_code: Optional[int] = None,
    ):
        super().__init__(message)
        self.route = route
        self.original_error = original_error
        self.status_code = status_code
        # Propagate status from original error if available
        if status_code is None and original_error and hasattr(original_error, "status"):
            self.status = original_error.status
        else:
            self.status = status_code


class RouteExecutor:
    """
    Executes resolved routes with automatic protocol conversion.

    The RouteExecutor handles the complexity of:
    1. Creating providers with route-specific configuration
    2. Converting requests between protocols when needed
    3. Converting responses back to the target protocol
    4. Supporting both streaming and non-streaming calls
    """

    def __init__(self):
        """Initialize the RouteExecutor."""
        pass

    async def execute(
        self,
        route: ResolvedRoute,
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
    ) -> Dict[str, Any]:
        """
        Execute a route and return response in target protocol format.

        This method handles protocol conversion automatically:
        - If route.wire_protocol matches target_protocol, no conversion needed
        - If they differ, request is converted before calling, response after

        Args:
            route: Resolved route with provider, model, api_key, etc.
            request_data: Request payload in target_protocol format
            target_protocol: The protocol the client expects ("openai" or "anthropic")

        Returns:
            Response dictionary in target_protocol format

        Raises:
            RouteExecutionError: If execution fails
        """
        source_protocol = route.wire_protocol

        logger.debug(
            f"Executing route: provider={route.provider}, model={route.model}, "
            f"source_protocol={source_protocol}, target_protocol={target_protocol}"
        )

        try:
            # Create provider with route-specific configuration
            provider = ProviderRegistry.get_provider_for_route(
                provider_name=route.provider,
                api_key=route.api_key,
                base_url=route.base_url,
            )

            # Convert request if protocols differ
            if source_protocol != target_protocol:
                converted_request = self._convert_request(
                    request_data, target_protocol, source_protocol
                )
            else:
                converted_request = request_data

            # Execute the call
            response = await self._call_provider(
                provider=provider,
                route=route,
                request=converted_request,
                protocol=source_protocol,
            )

            # Convert response back if protocols differ
            if source_protocol != target_protocol:
                model_name = request_data.get("model", route.model)
                return self._convert_response(
                    response, source_protocol, target_protocol, model_name
                )

            return response

        except RouteExecutionError:
            # Re-raise our own errors
            raise
        except Exception as e:
            err_msg = _format_error(e, route.provider, route.model)
            logger.error(f"Execution failed: {err_msg}")
            raise RouteExecutionError(
                message=f"Failed: {err_msg}",
                route=route,
                original_error=e,
            )

    async def execute_stream(
        self,
        route: ResolvedRoute,
        request_data: Dict[str, Any],
        target_protocol: WireProtocol,
    ) -> AsyncGenerator[str, None]:
        """
        Execute a streaming route with protocol conversion.

        For streaming, protocol conversion is more complex:
        - Request conversion happens before the call
        - Response (stream chunks) conversion happens per-chunk if needed

        Note: Full streaming protocol conversion (OpenAI SSE <-> Anthropic SSE)
        is complex. For cross-protocol streaming, consider using the appropriate
        adapter in the router layer.

        Args:
            route: Resolved route with provider, model, api_key, etc.
            request_data: Request payload in target_protocol format
            target_protocol: The protocol the client expects

        Yields:
            SSE-formatted chunks (protocol conversion may vary)

        Raises:
            RouteExecutionError: If execution fails
        """
        source_protocol = route.wire_protocol

        logger.debug(
            f"Executing streaming route: provider={route.provider}, "
            f"model={route.model}, source_protocol={source_protocol}, "
            f"target_protocol={target_protocol}"
        )

        try:
            # Create provider with route-specific configuration
            provider = ProviderRegistry.get_provider_for_route(
                provider_name=route.provider,
                api_key=route.api_key,
                base_url=route.base_url,
            )

            # Convert request if protocols differ
            if source_protocol != target_protocol:
                converted_request = self._convert_request(
                    request_data, target_protocol, source_protocol
                )
            else:
                converted_request = request_data

            # Execute the streaming call
            async for chunk in self._call_provider_stream(
                provider=provider,
                route=route,
                request=converted_request,
                protocol=source_protocol,
            ):
                # For now, yield chunks as-is
                # Full SSE protocol conversion would happen here
                yield chunk

        except RouteExecutionError:
            raise
        except Exception as e:
            err_msg = _format_error(e, route.provider, route.model)
            logger.error(f"Stream execution failed: {err_msg}")
            raise RouteExecutionError(
                message=f"Stream failed: {err_msg}",
                route=route,
                original_error=e,
            )

    def _convert_request(
        self,
        request_data: Dict[str, Any],
        from_protocol: WireProtocol,
        to_protocol: WireProtocol,
    ) -> Dict[str, Any]:
        """
        Convert request from one protocol format to another.

        Args:
            request_data: Request in from_protocol format
            from_protocol: Source protocol
            to_protocol: Target protocol

        Returns:
            Request in to_protocol format
        """
        if from_protocol == to_protocol:
            return request_data

        if from_protocol == "anthropic" and to_protocol == "openai":
            # Client sent Anthropic format, provider expects OpenAI
            return anthropic_to_openai_request(request_data)
        elif from_protocol == "openai" and to_protocol == "anthropic":
            # Client sent OpenAI format, provider expects Anthropic
            return openai_to_anthropic_request(request_data)
        else:
            # Unknown protocol combination, return as-is
            logger.warning(
                f"Unknown protocol conversion: {from_protocol} -> {to_protocol}"
            )
            return request_data

    def _convert_response(
        self,
        response: Dict[str, Any],
        from_protocol: WireProtocol,
        to_protocol: WireProtocol,
        model_name: str,
    ) -> Dict[str, Any]:
        """
        Convert response from one protocol format to another.

        Args:
            response: Response in from_protocol format
            from_protocol: Source protocol (provider's format)
            to_protocol: Target protocol (client's expected format)
            model_name: Model name to use in response

        Returns:
            Response in to_protocol format
        """
        if from_protocol == to_protocol:
            return response

        if from_protocol == "openai" and to_protocol == "anthropic":
            # Provider returned OpenAI format, client expects Anthropic
            return openai_to_anthropic_response(response, model_name)
        elif from_protocol == "anthropic" and to_protocol == "openai":
            # Provider returned Anthropic format, client expects OpenAI
            return anthropic_to_openai_response(response, model_name)
        else:
            # Unknown protocol combination, return as-is
            logger.warning(
                f"Unknown protocol conversion: {from_protocol} -> {to_protocol}"
            )
            return response

    async def _call_provider(
        self,
        provider,
        route: ResolvedRoute,
        request: Dict[str, Any],
        protocol: WireProtocol,
    ) -> Dict[str, Any]:
        """
        Make the actual provider call based on protocol.

        Args:
            provider: The provider instance to use
            route: Resolved route information
            request: Request data in the provider's expected protocol
            protocol: The protocol the provider expects

        Returns:
            Response dictionary from the provider
        """
        if protocol == "anthropic":
            return await provider.call(
                model=route.model,
                messages=request.get("messages", []),
                max_tokens=request.get("max_tokens", 4096),
                stream=False,
                temperature=request.get("temperature"),
                top_p=request.get("top_p"),
                top_k=request.get("top_k"),
                tools=request.get("tools"),
                system=request.get("system"),
            )
        else:
            # OpenAI protocol
            return await provider.call(
                model=route.model,
                messages=request.get("messages", []),
                temperature=request.get("temperature"),
                top_p=request.get("top_p"),
                n=request.get("n"),
                stream=False,
                stop=request.get("stop"),
                max_tokens=request.get("max_tokens"),
                presence_penalty=request.get("presence_penalty"),
                logit_bias=request.get("logit_bias"),
                user=request.get("user"),
                tools=request.get("tools"),
                tool_choice=request.get("tool_choice"),
            )

    async def _call_provider_stream(
        self,
        provider,
        route: ResolvedRoute,
        request: Dict[str, Any],
        protocol: WireProtocol,
    ) -> AsyncGenerator[str, None]:
        """
        Make a streaming provider call based on protocol.

        Args:
            provider: The provider instance to use
            route: Resolved route information
            request: Request data in the provider's expected protocol
            protocol: The protocol the provider expects

        Yields:
            Streaming chunks from the provider
        """
        if protocol == "anthropic":
            async for chunk in provider.call_stream(
                model=route.model,
                messages=request.get("messages", []),
                max_tokens=request.get("max_tokens", 4096),
                temperature=request.get("temperature"),
                top_p=request.get("top_p"),
                top_k=request.get("top_k"),
                tools=request.get("tools"),
                system=request.get("system"),
            ):
                yield chunk
        else:
            # OpenAI protocol
            async for chunk in provider.call_stream(
                model=route.model,
                messages=request.get("messages", []),
                temperature=request.get("temperature"),
                top_p=request.get("top_p"),
                n=request.get("n"),
                stop=request.get("stop"),
                max_tokens=request.get("max_tokens"),
                presence_penalty=request.get("presence_penalty"),
                logit_bias=request.get("logit_bias"),
                user=request.get("user"),
                tools=request.get("tools"),
                tool_choice=request.get("tool_choice"),
            ):
                yield chunk


# Singleton instance for convenience
_executor: Optional[RouteExecutor] = None


def get_executor() -> RouteExecutor:
    """
    Get the global RouteExecutor instance.

    Returns:
        RouteExecutor singleton instance
    """
    global _executor
    if _executor is None:
        _executor = RouteExecutor()
    return _executor
