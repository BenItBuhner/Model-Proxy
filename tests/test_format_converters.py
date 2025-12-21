"""
Tests for format converters module.
"""

import json

import pytest

from app.core.format_converters import (
    anthropic_to_openai_request,
    anthropic_to_openai_response,
    openai_to_anthropic_request,
    openai_to_anthropic_response,
)


def test_anthropic_to_openai_request_basic():
    """Test converting basic Anthropic request to OpenAI format."""
    anthropic_req = {
        "model": "claude-4.5-opus",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 100,
        "temperature": 0.7,
    }

    openai_req = anthropic_to_openai_request(anthropic_req)

    assert openai_req["model"] == "claude-4.5-opus"
    assert len(openai_req["messages"]) == 1
    assert openai_req["messages"][0]["role"] == "user"
    assert openai_req["messages"][0]["content"] == "Hello"
    assert openai_req["max_tokens"] == 100
    assert openai_req["temperature"] == 0.7


def test_anthropic_to_openai_request_with_tools():
    """Test converting Anthropic request with tools to OpenAI format."""
    anthropic_req = {
        "model": "claude-4.5-opus",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 100,
        "tools": [
            {
                "name": "get_weather",
                "description": "Get weather",
                "input_schema": {"type": "object", "properties": {}},
            }
        ],
    }

    openai_req = anthropic_to_openai_request(anthropic_req)

    assert "tools" in openai_req
    assert len(openai_req["tools"]) == 1
    assert openai_req["tools"][0]["type"] == "function"
    assert openai_req["tools"][0]["function"]["name"] == "get_weather"


def test_anthropic_to_openai_request_with_tool_results():
    """Anthropic tool_result blocks should become OpenAI tool messages."""
    anthropic_req = {
        "model": "claude-4.5-opus",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Use the tool."},
                    {
                        "type": "tool_result",
                        "tool_use_id": "call_1",
                        "content": [{"type": "text", "text": "42"}],
                    },
                ],
            }
        ],
        "max_tokens": 100,
    }

    openai_req = anthropic_to_openai_request(anthropic_req)

    assert len(openai_req["messages"]) == 2
    assert openai_req["messages"][0]["role"] == "user"
    assert openai_req["messages"][1]["role"] == "tool"
    assert openai_req["messages"][1]["tool_call_id"] == "call_1"
    assert "42" in openai_req["messages"][1]["content"]


def test_openai_to_anthropic_request_basic():
    """Test converting basic OpenAI request to Anthropic format."""
    openai_req = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Hello"}],
        "temperature": 0.7,
    }

    anthropic_req = openai_to_anthropic_request(openai_req)

    assert anthropic_req["model"] == "gpt-4"
    assert len(anthropic_req["messages"]) == 1
    assert anthropic_req["messages"][0]["role"] == "user"
    assert anthropic_req["messages"][0]["content"] == "Hello"
    assert anthropic_req["max_tokens"] == 1024  # Default
    assert anthropic_req["temperature"] == 0.7


def test_openai_to_anthropic_request_with_max_tokens():
    """Test converting OpenAI request with max_tokens."""
    openai_req = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 500,
    }

    anthropic_req = openai_to_anthropic_request(openai_req)
    assert anthropic_req["max_tokens"] == 500


def test_openai_to_anthropic_request_with_tools():
    """Test converting OpenAI request with tools to Anthropic format."""
    openai_req = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 100,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": {"type": "object"},
                },
            }
        ],
    }

    anthropic_req = openai_to_anthropic_request(openai_req)

    assert "tools" in anthropic_req
    assert len(anthropic_req["tools"]) == 1
    assert anthropic_req["tools"][0]["name"] == "get_weather"
    assert anthropic_req["tools"][0]["input_schema"] == {"type": "object"}


def test_openai_to_anthropic_request_with_tool_calls_and_results():
    """Assistant tool_calls and tool role responses should map to tool_use/tool_result blocks."""
    openai_req = {
        "model": "gpt-4",
        "messages": [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "add",
                            "arguments": json.dumps({"a": 1, "b": 2}),
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "3"},
        ],
        "max_tokens": 50,
    }

    anthropic_req = openai_to_anthropic_request(openai_req)

    assert len(anthropic_req["messages"]) == 2
    assistant_message = anthropic_req["messages"][0]
    user_message = anthropic_req["messages"][1]
    assert assistant_message["role"] == "assistant"
    assert any(
        block
        for block in assistant_message["content"]
        if isinstance(block, dict) and block.get("type") == "tool_use"
    )
    assert user_message["role"] == "user"
    assert isinstance(user_message["content"], list)
    assert user_message["content"][0]["type"] == "tool_result"


def test_anthropic_to_openai_response_basic():
    """Test converting basic Anthropic response to OpenAI format."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [{"type": "text", "text": "Hello, world!"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 20},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")

    assert openai_resp["model"] == "claude-4.5-opus"
    assert openai_resp["object"] == "chat.completion"
    assert len(openai_resp["choices"]) == 1
    assert openai_resp["choices"][0]["message"]["content"] == "Hello, world!"
    assert openai_resp["choices"][0]["finish_reason"] == "stop"
    assert openai_resp["usage"]["prompt_tokens"] == 10
    assert openai_resp["usage"]["completion_tokens"] == 20
    assert openai_resp["usage"]["total_tokens"] == 30


def test_anthropic_to_openai_response_with_tool_use():
    """Test converting Anthropic response with tool use."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [
            {
                "type": "tool_use",
                "id": "tool_1",
                "name": "get_weather",
                "input": {"location": "NYC"},
            }
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")

    assert "tool_calls" in openai_resp["choices"][0]["message"]
    tool_calls = openai_resp["choices"][0]["message"]["tool_calls"]
    assert len(tool_calls) == 1
    assert tool_calls[0]["id"] == "tool_1"
    assert tool_calls[0]["function"]["name"] == "get_weather"
    assert openai_resp["choices"][0]["finish_reason"] == "tool_calls"


def test_openai_to_anthropic_response_basic():
    """Test converting basic OpenAI response to Anthropic format."""
    openai_resp = {
        "id": "chatcmpl-123",
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Hello, world!"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")

    assert anthropic_resp["model"] == "gpt-4"
    assert anthropic_resp["type"] == "message"
    assert anthropic_resp["role"] == "assistant"
    assert len(anthropic_resp["content"]) == 1
    assert anthropic_resp["content"][0]["type"] == "text"
    assert anthropic_resp["content"][0]["text"] == "Hello, world!"
    assert anthropic_resp["stop_reason"] == "end_turn"
    assert anthropic_resp["usage"]["input_tokens"] == 10
    assert anthropic_resp["usage"]["output_tokens"] == 20
    assert anthropic_resp["usage"]["cache_creation_input_tokens"] == 0
    assert anthropic_resp["usage"]["cache_read_input_tokens"] == 0


def test_openai_to_anthropic_response_with_tool_calls():
    """Test converting OpenAI response with tool calls."""
    openai_resp = {
        "id": "chatcmpl-123",
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": json.dumps({"location": "NYC"}),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")

    assert len(anthropic_resp["content"]) == 1
    assert anthropic_resp["content"][0]["type"] == "tool_use"
    assert anthropic_resp["content"][0]["name"] == "get_weather"
    assert anthropic_resp["content"][0]["input"]["location"] == "NYC"


def test_response_round_trip():
    """Test that conversions are reversible (approximately)."""
    # Start with Anthropic response
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [{"type": "text", "text": "Hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 20},
    }

    # Convert to OpenAI
    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")

    # Convert back to Anthropic
    anthropic_resp_2 = openai_to_anthropic_response(openai_resp, "claude-4.5-opus")

    # Content should be preserved
    assert anthropic_resp_2["content"][0]["text"] == "Hello"
    assert anthropic_resp_2["usage"]["input_tokens"] == 10
    assert anthropic_resp_2["usage"]["output_tokens"] == 20
    assert anthropic_resp_2["usage"]["cache_creation_input_tokens"] == 0
    assert anthropic_resp_2["usage"]["cache_read_input_tokens"] == 0
