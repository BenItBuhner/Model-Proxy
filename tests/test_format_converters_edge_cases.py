"""
Comprehensive tests for format converters edge cases.
"""

import json

import pytest

from app.core.format_converters import (
    anthropic_to_openai_request,
    anthropic_to_openai_response,
    openai_to_anthropic_request,
    openai_to_anthropic_response,
)


def test_openai_to_anthropic_request_empty_messages():
    """Test converting OpenAI request with empty messages."""
    openai_req = {"model": "gpt-4", "messages": []}

    anthropic_req = openai_to_anthropic_request(openai_req)
    assert anthropic_req["messages"] == []
    assert anthropic_req["max_tokens"] == 1024  # Default


def test_openai_to_anthropic_request_content_list():
    """Test converting OpenAI request with list content."""
    openai_req = {
        "model": "gpt-4",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Hello"},
                    {"type": "text", "text": " World"},
                ],
            }
        ],
    }

    anthropic_req = openai_to_anthropic_request(openai_req)
    assert anthropic_req["messages"][0]["content"] == "Hello World"


def test_openai_to_anthropic_request_none_content():
    """Test converting OpenAI request with None content."""
    openai_req = {"model": "gpt-4", "messages": [{"role": "user", "content": None}]}

    anthropic_req = openai_to_anthropic_request(openai_req)
    assert anthropic_req["messages"][0]["content"] == ""


def test_openai_to_anthropic_request_stop_sequences():
    """Ensure stop strings and lists map to stop_sequences."""
    openai_req = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Hi"}],
        "stop": ["DONE", "END"],
    }

    anthropic_req = openai_to_anthropic_request(openai_req)
    assert anthropic_req["stop_sequences"] == ["DONE", "END"]


def test_anthropic_to_openai_request_empty_content():
    """Test converting Anthropic request with empty content."""
    anthropic_req = {
        "model": "claude-4.5-opus",
        "messages": [{"role": "user", "content": ""}],
        "max_tokens": 100,
    }

    openai_req = anthropic_to_openai_request(anthropic_req)
    assert openai_req["messages"][0]["content"] == ""


def test_anthropic_to_openai_response_empty_content():
    """Test converting Anthropic response with empty content."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 0},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
    assert openai_resp["choices"][0]["message"]["content"] == ""


def test_anthropic_to_openai_response_multiple_text_blocks():
    """Test converting Anthropic response with multiple text blocks."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [
            {"type": "text", "text": "Hello"},
            {"type": "text", "text": " World"},
            {"type": "text", "text": "!"},
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 3},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
    assert openai_resp["choices"][0]["message"]["content"] == "Hello World!"


def test_anthropic_to_openai_response_mixed_content():
    """Test converting Anthropic response with text and tool_use."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [
            {"type": "text", "text": "I'll check the weather."},
            {
                "type": "tool_use",
                "id": "tool_1",
                "name": "get_weather",
                "input": {"location": "NYC"},
            },
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
    assert "I'll check the weather." in openai_resp["choices"][0]["message"]["content"]
    assert len(openai_resp["choices"][0]["message"]["tool_calls"]) == 1


def test_openai_to_anthropic_response_empty_content():
    """Test converting OpenAI response with empty content."""
    openai_resp = {
        "id": "chatcmpl-123",
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": ""},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")
    assert len(anthropic_resp["content"]) == 0


def test_openai_to_anthropic_response_none_content():
    """Test converting OpenAI response with None content."""
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
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")
    assert len(anthropic_resp["content"]) == 1
    assert anthropic_resp["content"][0]["type"] == "tool_use"


def test_stop_reason_mapping():
    """Test all stop_reason to finish_reason mappings."""
    mappings = [
        ("end_turn", "stop"),
        ("max_tokens", "length"),
        ("stop_sequence", "stop"),
        ("tool_use", "tool_calls"),
    ]

    for stop_reason, expected_finish_reason in mappings:
        anthropic_resp = {
            "id": "msg_123",
            "model": "claude-4.5-opus",
            "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": stop_reason,
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }

        openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
        assert openai_resp["choices"][0]["finish_reason"] == expected_finish_reason


def test_finish_reason_mapping():
    """Test all finish_reason to stop_reason mappings."""
    mappings = [
        ("stop", "end_turn"),
        ("length", "max_tokens"),
        ("tool_calls", "end_turn"),
    ]

    for finish_reason, expected_stop_reason in mappings:
        openai_resp = {
            "id": "chatcmpl-123",
            "model": "gpt-4",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello"},
                    "finish_reason": finish_reason,
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        }

        anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")
        assert anthropic_resp["stop_reason"] == expected_stop_reason


def test_tool_arguments_json_parsing():
    """Test parsing tool call arguments from JSON string."""
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
                                "arguments": json.dumps(
                                    {"location": "NYC", "units": "celsius"}
                                ),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")
    tool_input = anthropic_resp["content"][0]["input"]
    assert tool_input["location"] == "NYC"
    assert tool_input["units"] == "celsius"


def test_tool_arguments_invalid_json():
    """Test handling invalid JSON in tool arguments."""
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
                                "arguments": "invalid json{",
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }

    anthropic_resp = openai_to_anthropic_response(openai_resp, "gpt-4")
    # Should handle gracefully with empty dict
    assert anthropic_resp["content"][0]["input"] == {}


def test_usage_calculation():
    """Test usage token calculation."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [{"type": "text", "text": "Hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 15, "output_tokens": 25},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
    assert openai_resp["usage"]["prompt_tokens"] == 15
    assert openai_resp["usage"]["completion_tokens"] == 25
    assert openai_resp["usage"]["total_tokens"] == 40


def test_multiple_tool_calls():
    """Test converting multiple tool calls."""
    anthropic_resp = {
        "id": "msg_123",
        "model": "claude-4.5-opus",
        "content": [
            {
                "type": "tool_use",
                "id": "tool_1",
                "name": "get_weather",
                "input": {"location": "NYC"},
            },
            {
                "type": "tool_use",
                "id": "tool_2",
                "name": "get_time",
                "input": {"timezone": "EST"},
            },
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }

    openai_resp = anthropic_to_openai_response(anthropic_resp, "claude-4.5-opus")
    assert len(openai_resp["choices"][0]["message"]["tool_calls"]) == 2
    assert (
        openai_resp["choices"][0]["message"]["tool_calls"][0]["function"]["name"]
        == "get_weather"
    )
    assert (
        openai_resp["choices"][0]["message"]["tool_calls"][1]["function"]["name"]
        == "get_time"
    )
