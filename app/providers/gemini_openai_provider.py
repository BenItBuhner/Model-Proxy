"""
Gemini OpenAI-compatible provider implementation.
Uses Google's OpenAI-compatible endpoint for Gemini models.
Strips unsupported parameters and handles Gemini-specific quirks.
"""

import json
import logging
import os
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

import httpx

from app.core.api_key_manager import get_available_keys
from app.providers.base import BaseProvider

logger = logging.getLogger("gemini_openai_provider")

# Gemini OpenAI-compatible endpoint
GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

# Whether to include Gemini's thought_signature in responses (default: false)
# Most clients don't support this Gemini-specific extension
GEMINI_INCLUDE_THOUGHT_SIGNATURE = os.getenv(
    "GEMINI_INCLUDE_THOUGHT_SIGNATURE", "false"
).lower() in ("true", "1", "yes")

# Store thought_signatures keyed by tool_call ID for injection on subsequent requests
# This is needed because Gemini requires thought_signature when sending tool results
_thought_signature_cache: Dict[str, str] = {}


class GeminiAPIError(Exception):
    """Gemini API request failed."""

    def __init__(self, message: str, status: int, body: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.body = body


class GeminiOpenAIProvider(BaseProvider):
    """Provider for Gemini using Google's OpenAI-compatible endpoint."""

    def __init__(self):
        super().__init__("gemini")
        self.base_url = GEMINI_OPENAI_BASE_URL
        self.timeout = 120  # Gemini can be slow

    def _get_available_api_keys(self) -> List[str]:
        """Get list of API keys to try."""
        if self._route_api_key:
            return [self._route_api_key]
        return get_available_keys(self.provider_name)

    def _get_endpoint_url(self) -> str:
        """Get the chat completions endpoint URL."""
        base = self._route_base_url or self.base_url
        if base.endswith("/"):
            return f"{base}chat/completions"
        return f"{base}/chat/completions"

    def _strip_gemini_extensions(
        self, data: Dict, has_seen_tool_calls: bool = False
    ) -> Tuple[Dict, bool]:
        """
        Strip Gemini-specific extensions from response data.
        Removes extra_content (containing thought_signature) from tool_calls
        unless GEMINI_INCLUDE_THOUGHT_SIGNATURE is enabled.
        Also removes empty tool_calls and normalizes format for OpenAI compatibility.
        Caches thought_signatures for injection on subsequent requests.

        Returns tuple of (cleaned_data, had_tool_calls) to track tool_call state.
        """
        global _thought_signature_cache
        had_tool_calls = False

        if "choices" not in data:
            return data, had_tool_calls

        for choice in data.get("choices", []):
            # Handle streaming delta format
            delta = choice.get("delta", {})
            if "tool_calls" in delta:
                if not GEMINI_INCLUDE_THOUGHT_SIGNATURE:
                    cleaned_tool_calls = []
                    for tool_call in delta["tool_calls"]:
                        # Cache thought_signature before stripping
                        tool_call_id = tool_call.get("id")
                        extra_content = tool_call.get("extra_content", {})
                        thought_sig = extra_content.get("google", {}).get(
                            "thought_signature"
                        )
                        if tool_call_id and thought_sig:
                            _thought_signature_cache[tool_call_id] = thought_sig

                        if "extra_content" in tool_call:
                            del tool_call["extra_content"]
                        # Only keep tool_calls that have actual content (id, type, or function)
                        if (
                            tool_call.get("id")
                            or tool_call.get("type")
                            or tool_call.get("function")
                        ):
                            # Ensure required fields for OpenAI compatibility
                            if tool_call.get("function") and "type" not in tool_call:
                                tool_call["type"] = "function"
                            cleaned_tool_calls.append(tool_call)
                    # Re-index after cleaning and ensure all have index
                    for idx, tool_call in enumerate(cleaned_tool_calls):
                        if "index" not in tool_call:
                            tool_call["index"] = idx
                    if cleaned_tool_calls:
                        delta["tool_calls"] = cleaned_tool_calls
                        had_tool_calls = True
                    else:
                        del delta["tool_calls"]
                else:
                    had_tool_calls = True

            # Fix finish_reason: if we've seen tool_calls, change "stop" to "tool_calls"
            if has_seen_tool_calls and choice.get("finish_reason") == "stop":
                choice["finish_reason"] = "tool_calls"

            # Handle non-streaming message format
            message = choice.get("message", {})
            if "tool_calls" in message:
                if not GEMINI_INCLUDE_THOUGHT_SIGNATURE:
                    cleaned_tool_calls = []
                    for tool_call in message["tool_calls"]:
                        # Cache thought_signature before stripping
                        tool_call_id = tool_call.get("id")
                        extra_content = tool_call.get("extra_content", {})
                        thought_sig = extra_content.get("google", {}).get(
                            "thought_signature"
                        )
                        if tool_call_id and thought_sig:
                            _thought_signature_cache[tool_call_id] = thought_sig

                        if "extra_content" in tool_call:
                            del tool_call["extra_content"]
                        # Only keep tool_calls that have actual content
                        if (
                            tool_call.get("id")
                            or tool_call.get("type")
                            or tool_call.get("function")
                        ):
                            # Ensure required fields for OpenAI compatibility
                            if tool_call.get("function") and "type" not in tool_call:
                                tool_call["type"] = "function"
                            cleaned_tool_calls.append(tool_call)
                    # Re-index after cleaning and ensure all have index
                    for idx, tool_call in enumerate(cleaned_tool_calls):
                        if "index" not in tool_call:
                            tool_call["index"] = idx
                    if cleaned_tool_calls:
                        message["tool_calls"] = cleaned_tool_calls
                        had_tool_calls = True
                    else:
                        del message["tool_calls"]
                else:
                    had_tool_calls = True

        return data, had_tool_calls

    def _inject_thought_signatures(self, messages: List[Dict]) -> List[Dict]:
        """
        Inject cached thought_signatures back into assistant messages with tool_calls.
        This is needed because Gemini requires thought_signature when processing tool results.
        """
        global _thought_signature_cache

        for msg in messages:
            if msg.get("role") == "assistant" and "tool_calls" in msg:
                for tool_call in msg["tool_calls"]:
                    tool_call_id = tool_call.get("id")
                    if tool_call_id and tool_call_id in _thought_signature_cache:
                        # Inject the cached thought_signature
                        if "extra_content" not in tool_call:
                            tool_call["extra_content"] = {}
                        if "google" not in tool_call["extra_content"]:
                            tool_call["extra_content"]["google"] = {}
                        tool_call["extra_content"]["google"]["thought_signature"] = (
                            _thought_signature_cache[tool_call_id]
                        )

        return messages

    def _sanitize_messages(self, messages: List[Dict]) -> List[Dict]:
        """
        Sanitize messages for Gemini compatibility.
        Only keeps fields that Gemini's OpenAI endpoint supports.
        Injects cached thought_signatures for tool_call continuations.
        """
        # First inject any cached thought_signatures
        messages = self._inject_thought_signatures(messages)

        sanitized = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue

            clean_msg = {}

            # Role is required
            role = msg.get("role")
            if not role:
                continue
            clean_msg["role"] = role

            # Content - handle string or list format
            content = msg.get("content")
            if content is not None:
                if isinstance(content, str):
                    clean_msg["content"] = content
                elif isinstance(content, list):
                    # Gemini supports multimodal content
                    clean_msg["content"] = content
                else:
                    clean_msg["content"] = str(content)

            # Tool calls for assistant messages
            if role == "assistant" and msg.get("tool_calls"):
                clean_msg["tool_calls"] = msg["tool_calls"]

            # Tool response fields
            if role == "tool":
                if msg.get("tool_call_id"):
                    clean_msg["tool_call_id"] = msg["tool_call_id"]
                if msg.get("name"):
                    clean_msg["name"] = msg["name"]

            sanitized.append(clean_msg)

        return sanitized

    def _build_payload(
        self,
        model: str,
        messages: List[Dict],
        stream: bool,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        top_p: Optional[float] = None,
        tools: Optional[List[Dict]] = None,
        tool_choice: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Build request payload with only Gemini-supported parameters.
        """
        payload = {
            "model": model,
            "messages": self._sanitize_messages(messages),
            "stream": stream,
        }

        # Only include optional params if they have non-default values
        if temperature is not None and temperature != 1.0:
            payload["temperature"] = temperature

        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        if top_p is not None and top_p != 1.0:
            payload["top_p"] = top_p

        # Gemini supports tools/functions
        if tools:
            payload["tools"] = tools

        if tool_choice:
            payload["tool_choice"] = tool_choice

        return payload

    async def call(
        self,
        model: str,
        messages: list,
        temperature: Optional[float] = 1.0,
        top_p: Optional[float] = 1.0,
        n: Optional[int] = 1,
        stream: Optional[bool] = False,
        stop: Optional[List[str]] = None,
        max_tokens: Optional[int] = None,
        presence_penalty: Optional[float] = 0.0,
        frequency_penalty: Optional[float] = 0.0,
        logit_bias: Optional[Dict[str, float]] = None,
        user: Optional[str] = None,
        tools: Optional[List[Dict]] = None,
        tool_choice: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Make a non-streaming API call to Gemini."""
        available_keys = self._get_available_api_keys()
        if not available_keys:
            raise Exception("No Gemini API keys available")

        last_error = None

        for api_key in available_keys:
            try:
                endpoint_url = self._get_endpoint_url()
                payload = self._build_payload(
                    model=model,
                    messages=messages,
                    stream=False,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    tools=tools,
                    tool_choice=tool_choice,
                )

                headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                }

                logger.debug(f"Gemini request to {endpoint_url}, model={model}")

                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(
                        endpoint_url, headers=headers, json=payload
                    )

                    if response.status_code >= 400:
                        self._mark_key_failed(api_key)
                        error_body = response.text
                        # Extract error message from JSON if possible
                        error_msg = f"HTTP {response.status_code}"
                        try:
                            err_json = json.loads(error_body)
                            if isinstance(err_json, list) and err_json:
                                err_json = err_json[0]
                            if isinstance(err_json, dict):
                                error_msg = err_json.get("error", {}).get(
                                    "message", error_msg
                                )
                        except (json.JSONDecodeError, TypeError, KeyError):
                            pass
                        last_error = GeminiAPIError(
                            f"Gemini API error: {error_msg}",
                            status=response.status_code,
                            body=error_body,
                        )
                        continue

                    result = response.json()
                    cleaned, _ = self._strip_gemini_extensions(result)
                    return cleaned

            except GeminiAPIError:
                raise
            except Exception as e:
                self._mark_key_failed(api_key)
                logger.warning(f"Gemini call failed: {str(e)[:100]}")
                last_error = GeminiAPIError(
                    f"Gemini API error: {str(e)}", status=500, body=str(e)
                )
                continue

        raise last_error or Exception("All Gemini API keys failed")

    async def call_stream(
        self,
        model: str,
        messages: list,
        temperature: Optional[float] = 1.0,
        top_p: Optional[float] = 1.0,
        n: Optional[int] = 1,
        stop: Optional[List[str]] = None,
        max_tokens: Optional[int] = None,
        presence_penalty: Optional[float] = 0.0,
        logit_bias: Optional[Dict[str, float]] = None,
        user: Optional[str] = None,
        tools: Optional[List[Dict]] = None,
        tool_choice: Optional[str] = None,
        **kwargs,
    ) -> AsyncGenerator[str, None]:
        """Make a streaming API call to Gemini."""
        available_keys = self._get_available_api_keys()
        if not available_keys:
            raise Exception("No Gemini API keys available")

        last_error = None

        for api_key in available_keys:
            try:
                endpoint_url = self._get_endpoint_url()
                payload = self._build_payload(
                    model=model,
                    messages=messages,
                    stream=True,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    tools=tools,
                    tool_choice=tool_choice,
                )

                headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                }

                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    async with client.stream(
                        "POST", endpoint_url, headers=headers, json=payload
                    ) as response:
                        if response.status_code >= 400:
                            error_text = await response.aread()
                            self._mark_key_failed(api_key)
                            error_body = error_text.decode(errors="replace")
                            # Extract error message from JSON if possible
                            error_msg = f"HTTP {response.status_code}"
                            try:
                                err_json = json.loads(error_body)
                                if isinstance(err_json, list) and err_json:
                                    err_json = err_json[0]
                                if isinstance(err_json, dict):
                                    error_msg = err_json.get("error", {}).get(
                                        "message", error_msg
                                    )
                            except (json.JSONDecodeError, TypeError, KeyError):
                                pass
                            last_error = GeminiAPIError(
                                f"Gemini API error: {error_msg}",
                                status=response.status_code,
                                body=error_body,
                            )
                            continue

                        # Process SSE stream - track if we've seen tool_calls
                        has_seen_tool_calls = False
                        async for line in response.aiter_lines():
                            if not line:
                                continue

                            line = line.strip()
                            if not line:
                                continue

                            # Check for ResponseStreamResult error in any line
                            if (
                                "ResponseStreamResult" in line
                                or "did not match any variant" in line
                            ):
                                logger.warning(
                                    f"Gemini stream format error: {line[:200]}"
                                )
                                self._mark_key_failed(api_key)
                                raise GeminiAPIError(
                                    f"Gemini streaming format error: {line[:200]}",
                                    status=400,
                                    body=line,
                                )

                            # Handle [DONE] marker
                            if line == "data: [DONE]":
                                yield "data: [DONE]\n\n"
                                continue

                            # Skip empty data lines
                            if line == "data:":
                                continue

                            # Process data lines
                            if line.startswith("data:"):
                                json_str = line[5:].strip()
                                if not json_str or json_str == "[DONE]":
                                    if json_str == "[DONE]":
                                        yield "data: [DONE]\n\n"
                                    continue

                                try:
                                    parsed = json.loads(json_str)

                                    # Check for embedded errors
                                    if "error" in parsed:
                                        error_msg = parsed.get("error", {}).get(
                                            "message", str(parsed)
                                        )
                                        logger.warning(
                                            f"Gemini embedded error: {error_msg[:200]}"
                                        )
                                        self._mark_key_failed(api_key)
                                        raise GeminiAPIError(
                                            f"Gemini stream error: {error_msg}",
                                            status=500,
                                            body=json_str,
                                        )

                                    # Strip Gemini extensions and forward valid chunks
                                    cleaned, had_tool_calls = (
                                        self._strip_gemini_extensions(
                                            parsed, has_seen_tool_calls
                                        )
                                    )
                                    if had_tool_calls:
                                        has_seen_tool_calls = True
                                    yield f"data: {json.dumps(cleaned)}\n\n"

                                except json.JSONDecodeError:
                                    # Check for known error patterns
                                    if (
                                        "ResponseStreamResult" in json_str
                                        or "error" in json_str.lower()
                                    ):
                                        self._mark_key_failed(api_key)
                                        raise GeminiAPIError(
                                            f"Gemini streaming error: {json_str[:200]}",
                                            status=500,
                                            body=json_str,
                                        )
                                    continue

                        # Successfully completed stream
                        return

            except GeminiAPIError:
                raise
            except Exception as e:
                self._mark_key_failed(api_key)
                logger.warning(f"Gemini stream failed: {str(e)[:100]}")
                last_error = GeminiAPIError(
                    f"Gemini API error: {str(e)}", status=500, body=str(e)
                )
                continue

        if last_error:
            raise last_error
        raise Exception("All Gemini API keys failed")
