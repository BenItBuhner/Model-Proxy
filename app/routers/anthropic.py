"""
Anthropic-compatible API router.
Provides /v1/messages endpoint with full fallback routing support.

This router implements the Anthropic Messages API format and handles:
- Request validation and normalization
- Fallback routing through multiple providers/models
- Protocol conversion for non-Anthropic providers
- Streaming with OpenAI-to-Anthropic SSE conversion
- Request/response logging
"""

import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth import CLIENT_API_KEY, verify_client_api_key
from app.core.error_formatters import create_provider_error_response
from app.core.logging import (
    extract_parameters_from_request,
    extract_response_content,
    extract_usage_from_response,
    hash_api_key,
)
from app.database import crud, logging_crud
from app.database.database import SessionLocal
from app.models.anthropic import AnthropicMessagesRequest, AnthropicMessagesResponse
from app.routing.config_loader import config_loader
from app.routing.models import RoutingError
from app.routing.router import FallbackRouter

logger = logging.getLogger("anthropic_router")


def _log_bad_request(endpoint: str, detail: Any, payload: Any) -> None:
    """Log 400-level failures with request payload for debugging."""
    try:
        serialized = json.dumps(payload, ensure_ascii=False)
    except Exception:
        serialized = str(payload)
    logger.warning(
        "Anthropic router 400 on %s: detail=%s payload=%s",
        endpoint,
        detail,
        serialized,
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


router = APIRouter()


class OpenAIStreamAdapter:
    """Translates OpenAI-style SSE chunks into Anthropic-compatible SSE."""

    STOP_REASON_MAP = {
        "stop": "end_turn",
        "length": "max_tokens",
        "content_filter": "content_filter",
        "tool_calls": "tool_use",
        "function_call": "tool_use",
    }

    def __init__(self, requested_model: str):
        self.requested_model = requested_model
        self.message_id = f"msg_{uuid.uuid4().hex}"
        self.response_content: List[Dict[str, Any]] = []
        self.active_blocks: Dict[int, Dict[str, Any]] = {}
        self.current_text_index: Optional[int] = None
        self.next_block_index = 0
        self.tool_state: Dict[str, Dict[str, Any]] = {}
        self.finish_reason: Optional[str] = None
        self.usage: Optional[Dict[str, Any]] = None

    def _sse(self, event: str, payload: Dict[str, Any]):
        data = json.dumps(payload, separators=(",", ":"))
        yield f"event: {event}\n"
        yield f"data: {data}\n\n"

    def start(self):
        message_payload = {
            "type": "message_start",
            "message": {
                "id": self.message_id,
                "type": "message",
                "role": "assistant",
                "model": self.requested_model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
            },
        }
        yield from self._sse("message_start", message_payload)

    def process_chunk(self, raw_chunk: str):
        try:
            lines = raw_chunk.splitlines()
        except Exception:
            lines = [raw_chunk]
        for line in lines:
            stripped = line.strip()
            if not stripped or not stripped.startswith("data:"):
                continue
            payload = stripped[5:].strip()
            if not payload:
                continue
            if payload == "[DONE]":
                continue
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            yield from self._handle_openai_object(obj)

    def _handle_openai_object(self, obj: Dict[str, Any]):
        usage = obj.get("usage")
        if usage:
            self.usage = usage
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            return
        choice = choices[0]
        delta = choice.get("delta") or {}
        finish_reason = choice.get("finish_reason")
        if finish_reason:
            self.finish_reason = finish_reason
        if delta:
            yield from self._handle_delta(delta)

    def _handle_delta(self, delta: Dict[str, Any]):
        content = delta.get("content")
        if isinstance(content, list):
            for part in content:
                part_type = part.get("type")
                if part_type == "text":
                    yield from self._emit_text(part.get("text", ""))
                elif part_type == "tool_call":
                    fn = part.get("function", {}) or {}
                    tool_id = (
                        part.get("id")
                        or fn.get("name")
                        or f"tool_{len(self.tool_state)}"
                    )
                    name = fn.get("name") or tool_id
                    args_value = fn.get("arguments") or ""
                    idx = yield from self._ensure_tool_block(tool_id, name)
                    yield from self._emit_tool_args(tool_id, idx, args_value)
        elif isinstance(content, str):
            yield from self._emit_text(content)
        elif content:
            yield from self._emit_text(str(content))

        tool_calls = delta.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                fn = call.get("function", {}) or {}
                tool_id = (
                    call.get("id") or fn.get("name") or f"tool_{len(self.tool_state)}"
                )
                name = fn.get("name") or tool_id
                args_value = fn.get("arguments") or ""
                idx = yield from self._ensure_tool_block(tool_id, name)
                yield from self._emit_tool_args(tool_id, idx, args_value)

    def _emit_text(self, text_value: str):
        if not text_value:
            return
        idx = yield from self._ensure_text_block()
        block = self.active_blocks.get(idx)
        if block is not None:
            block["text"] = block.get("text", "") + text_value
        payload = {
            "type": "content_block_delta",
            "index": idx,
            "delta": {"type": "text_delta", "text": text_value},
        }
        yield from self._sse("content_block_delta", payload)

    def _ensure_text_block(self):
        if self.current_text_index is not None:
            return self.current_text_index
        idx = self._next_block_index()
        block = {"type": "text", "text": ""}
        self.response_content.append(block)
        self.active_blocks[idx] = block
        self.current_text_index = idx
        payload = {
            "type": "content_block_start",
            "index": idx,
            "content_block": {"type": "text", "text": ""},
        }
        yield from self._sse("content_block_start", payload)
        return idx

    def _ensure_tool_block(self, tool_id: str, tool_name: str):
        if tool_id in self.tool_state:
            return self.tool_state[tool_id]["block_index"]
        if self.current_text_index is not None:
            yield from self._finalize_block(self.current_text_index)
        idx = self._next_block_index()
        block = {"type": "tool_use", "id": tool_id, "name": tool_name, "input": {}}
        self.response_content.append(block)
        self.active_blocks[idx] = block
        self.tool_state[tool_id] = {"block_index": idx, "buffer": "", "name": tool_name}
        payload = {
            "type": "content_block_start",
            "index": idx,
            "content_block": {
                "type": "tool_use",
                "id": tool_id,
                "name": tool_name,
                "input": {},
            },
        }
        yield from self._sse("content_block_start", payload)
        return idx

    def _emit_tool_args(self, tool_id: str, block_index: int, arguments: str):
        state = self.tool_state.get(tool_id)
        if state is None:
            return
        prev = state.get("buffer", "")
        full_args = arguments or ""
        delta_text = full_args[len(prev) :] if full_args.startswith(prev) else full_args
        state["buffer"] = full_args
        if not delta_text:
            return
        payload = {
            "type": "content_block_delta",
            "index": block_index,
            "delta": {"type": "input_json_delta", "partial_json": delta_text},
        }
        yield from self._sse("content_block_delta", payload)

    def _next_block_index(self) -> int:
        idx = self.next_block_index
        self.next_block_index += 1
        return idx

    def _finalize_block(self, idx: int):
        block = self.active_blocks.pop(idx, None)
        if not block:
            return
        if block.get("type") == "text":
            if self.current_text_index == idx:
                self.current_text_index = None
        elif block.get("type") == "tool_use":
            tool_id = block.get("id")
            state = self.tool_state.pop(tool_id, None) if tool_id else None
            buffer = state.get("buffer", "") if state else ""
            if buffer:
                try:
                    block["input"] = json.loads(buffer)
                except json.JSONDecodeError:
                    block["input"] = {"_raw": buffer}
        payload = {"type": "content_block_stop", "index": idx}
        yield from self._sse("content_block_stop", payload)

    def finalize(self):
        # Close tool blocks first so their inputs are captured.
        for tool_id, state in list(self.tool_state.items()):
            yield from self._finalize_block(state["block_index"])
        if self.current_text_index is not None:
            yield from self._finalize_block(self.current_text_index)
        # Close any remaining blocks.
        for idx in list(self.active_blocks.keys()):
            yield from self._finalize_block(idx)

        message_payload = {
            "type": "message_stop",
            "message": {
                "id": self.message_id,
                "type": "message",
                "role": "assistant",
                "model": self.requested_model,
                "content": self.response_content,
                "stop_reason": self._stop_reason(),
                "stop_sequence": None,
                "usage": self._usage_payload(),
            },
        }
        yield from self._sse("message_stop", message_payload)
        yield "data: [DONE]\n\n"

    def _usage_payload(self) -> Dict[str, Any]:
        usage = self.usage or {}
        return {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        }

    def _stop_reason(self) -> str:
        if self.finish_reason:
            return self.STOP_REASON_MAP.get(self.finish_reason, "end_turn")
        return "end_turn"


async def _create_streaming_response(
    request_dict: Dict[str, Any],
    requested_model: str,
    request_id: Optional[str],
    start_time: float,
    db: Session,
    client_api_key_hash: Optional[str],
    fallback_router: FallbackRouter,
):
    """Create a streaming response with full fallback routing support."""

    async def generate_stream():
        try:
            # Get the stream generator from fallback router
            stream_generator = await fallback_router.call_with_fallback(
                logical_model=requested_model,
                request_data=request_dict,
                target_protocol="anthropic",
                stream=True,
            )

            # Check if we need to convert from OpenAI format
            # For simplicity, we'll use an adapter that handles both formats
            adapter = OpenAIStreamAdapter(requested_model)
            is_anthropic_native = False
            first_chunk_processed = False

            # Start the Anthropic message structure
            for chunk in adapter.start():
                yield chunk

            async for raw_chunk in stream_generator:
                if not first_chunk_processed:
                    # Detect if this is native Anthropic format
                    if "event:" in raw_chunk or '"type":"message_start"' in raw_chunk:
                        is_anthropic_native = True
                    first_chunk_processed = True

                if is_anthropic_native:
                    # Pass through native Anthropic SSE
                    yield raw_chunk
                else:
                    # Convert OpenAI SSE to Anthropic format
                    for converted in adapter.process_chunk(raw_chunk):
                        yield converted

            # Finalize if we were converting
            if not is_anthropic_native:
                for chunk in adapter.finalize():
                    yield chunk

            # Update log on success
            if request_id:
                response_time_ms = int((time.time() - start_time) * 1000)
                try:
                    logging_crud.update_request_log(
                        db=db,
                        request_id=request_id,
                        response_status=200,
                        response_time_ms=response_time_ms,
                    )
                except Exception:
                    pass

        except RoutingError as e:
            # All routes failed
            error_event = {
                "type": "error",
                "error": {"type": "routing_error", "message": str(e)},
            }
            yield f"event: error\ndata: {json.dumps(error_event)}\n\n"
            yield "data: [DONE]\n\n"

            if request_id:
                response_time_ms = int((time.time() - start_time) * 1000)
                try:
                    logging_crud.update_request_log(
                        db=db,
                        request_id=request_id,
                        response_status=503,
                        response_time_ms=response_time_ms,
                        error_message=str(e),
                        error_type="RoutingError",
                    )
                except Exception:
                    pass

        except Exception as e:
            logger.error(f"Streaming error: {str(e)}")
            error_event = {
                "type": "error",
                "error": {"type": "internal_error", "message": str(e)},
            }
            yield f"event: error\ndata: {json.dumps(error_event)}\n\n"
            yield "data: [DONE]\n\n"

            if request_id:
                response_time_ms = int((time.time() - start_time) * 1000)
                try:
                    logging_crud.update_request_log(
                        db=db,
                        request_id=request_id,
                        response_status=500,
                        response_time_ms=response_time_ms,
                        error_message=str(e),
                        error_type=type(e).__name__,
                    )
                except Exception:
                    pass

    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/v1/messages", response_model=AnthropicMessagesResponse)
async def messages(
    request: AnthropicMessagesRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    _: bool = Depends(verify_client_api_key),
    beta: bool = Query(False, description="Enable beta (streaming) mode"),
):
    """
    Anthropic-compatible messages endpoint.
    Routes requests to appropriate provider based on model configuration.
    Supports full fallback routing (API key, provider, and model level).
    """
    request_id = getattr(http_request.state, "request_id", None)
    start_time = getattr(http_request.state, "start_time", time.time())
    client_api_key_hash = hash_api_key(CLIENT_API_KEY) if CLIENT_API_KEY else None
    request_payload: Optional[Dict[str, Any]] = None

    try:
        # Check if this model uses the fallback routing system
        try:
            config_loader.load_config(request.model)
            logical_model = request.model
        except (FileNotFoundError, ValueError) as e:
            # No routing config found for this model
            logger.warning(f"No routing config found for model '{request.model}': {e}")
            raise create_provider_error_response(
                "anthropic",
                400,
                f"Model '{request.model}' not found in routing configuration. "
                f"Available models can be found in config/models/",
                "invalid_request_error",
            )

        # Prepare request dict
        request_dict = request.model_dump(exclude_none=True)
        request_dict["stream"] = request_dict.get("stream", False) or beta
        request_payload = request_dict.copy()

        # Extract parameters for logging
        parameters = extract_parameters_from_request(request_dict)

        # Create initial log entry
        if request_id:
            logging_crud.create_request_log(
                db=db,
                request_id=request_id,
                endpoint="/v1/messages",
                method="POST",
                requested_model=request.model,
                resolved_provider="fallback_router",
                resolved_model=logical_model,
                parameters=parameters,
                messages=request_dict["messages"],
                client_api_key_hash=client_api_key_hash,
                is_streaming=request_dict["stream"],
            )

        # Create fallback router
        fallback_router = FallbackRouter()

        # Handle streaming
        if request_dict["stream"]:
            return await _create_streaming_response(
                request_dict=request_dict,
                requested_model=request.model,
                request_id=request_id,
                start_time=start_time,
                db=db,
                client_api_key_hash=client_api_key_hash,
                fallback_router=fallback_router,
            )

        # Non-streaming request
        response_data = await fallback_router.call_with_fallback(
            logical_model=logical_model,
            request_data=request_dict,
            target_protocol="anthropic",
            stream=False,
        )

        # Update model name to requested model (preserve client's model name)
        response_data["model"] = request.model

        # Calculate response time
        response_time_ms = int((time.time() - start_time) * 1000)

        # Extract response content and usage for logging
        response_content = extract_response_content(
            response_data, is_openai_format=False
        )
        usage = extract_usage_from_response(response_data)

        # Update log with response
        if request_id:
            try:
                logging_crud.update_request_log(
                    db=db,
                    request_id=request_id,
                    response_status=200,
                    response_time_ms=response_time_ms,
                    response_content=response_content,
                    response_usage=usage,
                )
            except Exception as log_error:
                logger.warning(f"Failed to update request log: {log_error}")

        # Legacy logging (keep for backward compatibility)
        try:
            crud.create_log(
                db,
                service="fallback_router",
                request=request_dict,
                response=response_data,
            )
        except Exception:
            pass

        return response_data

    except RoutingError as e:
        # All routes failed
        if request_id:
            try:
                response_time_ms = int((time.time() - start_time) * 1000)
                logging_crud.update_request_log(
                    db=db,
                    request_id=request_id,
                    response_status=503,
                    response_time_ms=response_time_ms,
                    error_message=str(e),
                    error_type="RoutingError",
                )
            except Exception:
                pass

        raise create_provider_error_response(
            "anthropic",
            503,
            f"All routes failed for model '{request.model}': {e.get_error_summary()}",
            "service_unavailable",
        )

    except HTTPException as e:
        # Log error
        if request_id:
            try:
                response_time_ms = int((time.time() - start_time) * 1000)
                error_detail = e.detail
                if isinstance(error_detail, dict):
                    error_obj = error_detail.get("error")
                    if isinstance(error_obj, dict):
                        error_message = error_obj.get("message", str(error_detail))
                    else:
                        error_message = str(error_detail)
                else:
                    error_message = str(error_detail)

                logging_crud.update_request_log(
                    db=db,
                    request_id=request_id,
                    response_status=e.status_code,
                    response_time_ms=response_time_ms,
                    error_message=error_message,
                    error_type=type(e).__name__,
                )
            except Exception:
                pass

        if e.status_code == 400:
            try:
                payload = request_payload or request.model_dump(exclude_none=True)
            except Exception:
                payload = request_payload or {}
            _log_bad_request("/v1/messages", e.detail, payload)
        raise

    except Exception as e:
        # Log error
        if request_id:
            try:
                response_time_ms = int((time.time() - start_time) * 1000)
                logging_crud.update_request_log(
                    db=db,
                    request_id=request_id,
                    response_status=500,
                    response_time_ms=response_time_ms,
                    error_message=str(e),
                    error_type=type(e).__name__,
                )
            except Exception:
                pass

        logger.exception(f"Unexpected error in /v1/messages: {e}")
        raise create_provider_error_response(
            "anthropic",
            500,
            f"Error processing request: {str(e)}",
            "internal_server_error",
        )


@router.post("/v1/messages/count_tokens")
async def messages_count_tokens(
    request: AnthropicMessagesRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    _: bool = Depends(verify_client_api_key),
):
    """
    Anthropic-compatible token counting endpoint.
    Returns an approximate token count for the request.
    """

    def approximate_tokens_from_text(text: str) -> int:
        """Rough approximation: ~4 characters per token."""
        return max(1, len(text) // 4)

    try:
        # Count tokens from messages
        total_tokens = 0
        request_dict = request.model_dump(exclude_none=True)

        for message in request_dict.get("messages", []):
            content = message.get("content", "")
            if isinstance(content, str):
                total_tokens += approximate_tokens_from_text(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        text = block.get("text", "")
                        if text:
                            total_tokens += approximate_tokens_from_text(text)

        # Add system prompt tokens if present
        system = request_dict.get("system")
        if system:
            if isinstance(system, str):
                total_tokens += approximate_tokens_from_text(system)
            elif isinstance(system, list):
                for block in system:
                    if isinstance(block, dict):
                        text = block.get("text", "")
                        if text:
                            total_tokens += approximate_tokens_from_text(text)

        return {"input_tokens": total_tokens}

    except Exception as e:
        logger.exception(f"Error counting tokens: {e}")
        raise create_provider_error_response(
            "anthropic",
            500,
            f"Error counting tokens: {str(e)}",
            "internal_server_error",
        )
