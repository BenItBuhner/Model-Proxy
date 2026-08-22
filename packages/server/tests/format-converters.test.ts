import { describe, expect, test } from "bun:test";

import {
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  parseArguments,
} from "../src/format/converters.ts";

describe("parseArguments", () => {
  test("passes through objects", () => {
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
  });
  test("returns {} for empty / null / undefined", () => {
    expect(parseArguments(undefined)).toEqual({});
    expect(parseArguments(null)).toEqual({});
    expect(parseArguments("")).toEqual({});
  });
  test("parses JSON strings", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
  });
  test("wraps non-JSON strings in _raw", () => {
    expect(parseArguments("not json")).toEqual({ _raw: "not json" });
  });
  test("wraps numbers in {value}", () => {
    expect(parseArguments(42)).toEqual({ value: 42 });
  });
});

describe("openaiToAnthropicRequest", () => {
  test("pulls system messages into top-level system field", () => {
    const result = openaiToAnthropicRequest({
      model: "m",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
      ],
      max_tokens: 256,
    });
    expect(result["system"]).toBe("Be helpful.");
    expect((result["messages"] as unknown[]).length).toBe(1);
  });

  test("converts tool message -> tool_result block on a user turn", () => {
    const result = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"nyc"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      max_tokens: 256,
    });

    const messages = result["messages"] as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1];
    expect(last?.["role"]).toBe("user");
    const content = last?.["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["type"]).toBe("tool_result");
    expect(content[0]?.["tool_use_id"]).toBe("call_1");
  });

  test("converts OpenAI tools -> Anthropic tools schema", () => {
    const result = openaiToAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "weather",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(result["tools"]).toEqual([
      {
        name: "get_weather",
        description: "weather",
        input_schema: { type: "object" },
      },
    ]);
  });

  test("maps Chat tool-choice semantics to Anthropic", () => {
    const base = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    };
    expect(openaiToAnthropicRequest({ ...base, tool_choice: "auto" })["tool_choice"])
      .toEqual({ type: "auto" });
    expect(openaiToAnthropicRequest({ ...base, tool_choice: "required" })["tool_choice"])
      .toEqual({ type: "any" });
    const disabled = openaiToAnthropicRequest({ ...base, tool_choice: "none" });
    expect(disabled["tool_choice"]).toBeUndefined();
    expect(disabled["tools"]).toBeUndefined();
    expect(openaiToAnthropicRequest({
      ...base,
      tool_choice: { type: "function", function: { name: "lookup" } },
    })["tool_choice"]).toEqual({ type: "tool", name: "lookup" });
  });
});

describe("anthropicToOpenaiRequest", () => {
  test("emits tool messages BEFORE user text in the same turn", () => {
    const result = anthropicToOpenaiRequest({
      model: "m",
      max_tokens: 256,
      system: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "search",
              input: { q: "x" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "ok" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    const messages = result["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[1]?.["role"]).toBe("assistant");
    expect(messages[2]?.["role"]).toBe("tool");
    expect(messages[3]?.["role"]).toBe("user");
    expect(messages[3]?.["content"]).toBe("thanks");
  });
});

describe("openaiToAnthropicResponse", () => {
  test("maps finish_reason tool_calls -> stop_reason tool_use", () => {
    const result = openaiToAnthropicResponse(
      {
        id: "c_1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "fn", arguments: '{"a":1}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      "claude-3",
    );
    expect(result["stop_reason"]).toBe("tool_use");
    const content = result["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["type"]).toBe("tool_use");
    expect(content[0]?.["input"]).toEqual({ a: 1 });
  });
});

describe("anthropicToOpenaiResponse", () => {
  test("collapses text + tool_use blocks and sets finish_reason=tool_calls", () => {
    const result = anthropicToOpenaiResponse(
      {
        id: "m_1",
        type: "message",
        role: "assistant",
        model: "claude-3",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "fn", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      "gpt-4",
    );
    const choices = result["choices"] as Array<Record<string, unknown>>;
    expect(choices[0]?.["finish_reason"]).toBe("tool_calls");
    const message = choices[0]?.["message"] as Record<string, unknown>;
    expect(message["content"]).toBeNull();
    const toolCalls = message["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.["id"]).toBe("t1");
    expect(
      JSON.parse(String((toolCalls[0]?.["function"] as Record<string, unknown>)["arguments"])),
    ).toEqual({ a: 1 });
    const usage = result["usage"] as Record<string, unknown>;
    expect(usage["total_tokens"]).toBe(7);
  });
});
