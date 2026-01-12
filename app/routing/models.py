"""
Pydantic models for routing configuration.
Defines the JSON schema for config/models/<logical_model>.json files.
Enhanced with additional types for routing execution.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class RouteConfig(BaseModel):
    """Configuration for a single provider route."""

    wire_protocol: Optional[Literal["openai", "anthropic"]] = Field(
        default=None,
        description=(
            "API protocol this route uses. Defaults to provider-compatible format "
            "when omitted."
        ),
    )
    provider: str = Field(
        ..., description="Provider name (e.g., 'cerebras', 'nahcrof', 'openai')"
    )
    model: str = Field(..., description="Concrete model name to send to the provider")
    base_url: Optional[str] = Field(
        default=None, description="Override base URL for this provider"
    )
    api_key_env: Optional[List[str]] = Field(
        default=None,
        description=(
            "Ordered list of environment variable names to try for API keys. "
            "If omitted, provider key patterns are used."
        ),
    )
    timeout_seconds: Optional[int] = Field(
        default=None, description="Timeout for this specific route"
    )
    cooldown_seconds: Optional[int] = Field(
        default=None,
        description="Route-specific cooldown duration in seconds for model-specific errors (429, 500)",
    )


class ModelRoutingConfig(BaseModel):
    """Configuration for a logical model with fallback routing."""

    logical_name: str = Field(
        ..., description="The logical model name (e.g., 'glm-4.6')"
    )
    timeout_seconds: Optional[int] = Field(
        default=60, description="Default timeout for all routes in seconds"
    )
    default_cooldown_seconds: int = Field(
        default=180,
        description="Default cooldown duration for routes without explicit cooldown_seconds",
    )
    model_routings: List[RouteConfig] = Field(
        ..., description="Ordered list of provider routes to try"
    )
    fallback_model_routings: List[str] = Field(
        default_factory=list,
        description="Ordered list of logical model names to fall back to",
    )


class ResolvedRoute(BaseModel):
    """A concrete route resolved from a logical model config."""

    source_logical_model: str = Field(
        ..., description="The logical model this route came from"
    )
    wire_protocol: Literal["openai", "anthropic"] = Field(
        ..., description="API protocol to use"
    )
    provider: str = Field(..., description="Provider name")
    model: str = Field(..., description="Concrete model name to send")
    base_url: Optional[str] = Field(default=None, description="Base URL to use")
    api_key: str = Field(..., description="Resolved API key to use")
    timeout_seconds: int = Field(..., description="Timeout in seconds")


class Attempt(BaseModel):
    """An attempt to execute a route with fallback metadata."""

    route: ResolvedRoute
    attempt_number: int = Field(
        ..., description="Sequential attempt number across all routes"
    )
    is_fallback_route: bool = Field(
        default=False, description="Whether this is from a fallback logical model"
    )


class AttemptResult(BaseModel):
    """Result of a single route attempt."""

    attempt: Attempt
    success: bool = Field(..., description="Whether the attempt succeeded")
    response: Optional[Dict[str, Any]] = Field(
        default=None, description="Response data if successful"
    )
    error: Optional[str] = Field(default=None, description="Error message if failed")
    error_type: Optional[str] = Field(
        default=None, description="Type of error if failed"
    )
    status_code: Optional[int] = Field(
        default=None, description="HTTP status code if applicable"
    )
    duration_ms: Optional[int] = Field(
        default=None, description="Duration of the attempt in milliseconds"
    )


class RoutingResult(BaseModel):
    """Result of a complete routing operation with all attempts."""

    logical_model: str = Field(..., description="The requested logical model")
    success: bool = Field(..., description="Whether any route succeeded")
    response: Optional[Dict[str, Any]] = Field(
        default=None, description="Final response if successful"
    )
    successful_attempt: Optional[Attempt] = Field(
        default=None, description="The attempt that succeeded"
    )
    total_attempts: int = Field(default=0, description="Total number of attempts made")
    failed_attempts: List[AttemptResult] = Field(
        default_factory=list, description="Details of failed attempts"
    )
    total_duration_ms: Optional[int] = Field(
        default=None, description="Total duration of all attempts"
    )


class RoutingError(Exception):
    """Error information when all routes fail."""

    def __init__(
        self,
        logical_model: str,
        attempted_routes: List[Attempt],
        errors: List[Dict[str, Any]],
        message: str,
    ):
        super().__init__(message)
        self.logical_model = logical_model
        self.attempted_routes = attempted_routes
        self.errors = errors
        self.message = message

    def to_dict(self) -> Dict[str, Any]:
        """Convert error to a dictionary for serialization."""
        return {
            "logical_model": self.logical_model,
            "attempted_routes_count": len(self.attempted_routes),
            "errors": self.errors,
            "message": self.message,
        }

    def get_error_summary(self) -> str:
        """Get a brief summary of the error."""
        error_count = len(self.errors)
        route_count = len(self.attempted_routes)
        return (
            f"All {route_count} routes failed for '{self.logical_model}' "
            f"with {error_count} error(s)"
        )
