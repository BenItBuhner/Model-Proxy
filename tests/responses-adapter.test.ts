import { describe, expect, test } from "bun:test";

import {
  chatResponseToResponses,
  chatStreamChunkToResponsesEvents,
  createResponsesStreamState,
  extractResponsesOutputText,
  finalizeResponsesStream,
  responsesRequestToChat,
} from "../src/format/responses.ts";

describe("responsesRequestToChat", () => {
  test("maps string input and instructions", () => {
    const chat = responsesRequestToChat({
      model: "glm-5.2",
      instructions: "Be brief.",
      input: "Say OK",
      max_output_tokens: 64,
      temperature: 0.2,
    });
    expect(chat["model"]).toBe("glm-5.2");
    expect(chat["max_tokens"]).toBe(64);
    expect(chat["max_completion_tokens"]).toBe(64);
    expect(chat["temperature"]).toBe(0.2);
    const messages = chat["messages"] as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Say OK" },
    ]);
  });

  test("maps message array with input_text parts", () => {
    const chat = responsesRequestToChat({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
    const messages = chat["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
  });

  test("maps function_call and function_call_output items", () => {
    const chat = responsesRequestToChat({
      model: "m",
      input: [
        { type: "message", role: "user", content: "use tool" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"q":"x"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
      ],
    });
    const messages = chat["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("user");
    expect(messages[1]?.["role"]).toBe("assistant");
    expect(messages[1]?.["tool_calls"]).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"x"}' },
      },
    ]);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "result",
    });
  });

  test("maps Responses-style tools to chat tools", () => {
    const chat = responsesRequestToChat({
      model: "m",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "add",
          description: "Add numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      ],
    });
    expect(chat["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "add",
          description: "Add numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      },
    ]);
  });
});

describe("chatResponseToResponses", () => {
  test("maps text completion", () => {
    const response = chatResponseToResponses(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
      { model: "glm-5.2" },
    );
    expect(response["object"]).toBe("response");
    expect(response["status"]).toBe("completed");
    expect(response["model"]).toBe("glm-5.2");
    expect(extractResponsesOutputText(response)).toBe("OK");
    expect(response["usage"]).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      total_tokens: 4,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("maps tool calls", () => {
    const response = chatResponseToResponses({
      id: "chatcmpl-2",
      created: 1,
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
    const output = response["output"] as Array<Record<string, unknown>>;
    const fc = output.find((item) => item["type"] === "function_call");
    expect(fc?.["call_id"]).toBe("call_abc");
    expect(fc?.["name"]).toBe("lookup");
    expect(fc?.["arguments"]).toBe("{}");
  });

  test("preserves reasoning, refusal, metadata, and usage details", () => {
    const response = chatResponseToResponses(
      {
        model: "m",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Done",
              reasoning_content: "I checked the inputs.",
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
      { metadata: { trace: "test" }, parallelToolCalls: false },
    );
    expect(response["metadata"]).toEqual({ trace: "test" });
    expect(response["parallel_tool_calls"]).toBe(false);
    expect((response["output"] as Array<Record<string, unknown>>)[0]?.["type"]).toBe("reasoning");
    expect(response["usage"]).toMatchObject({
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    });
  });
});

describe("responses streaming adapter", () => {
  test("maps chat SSE chunks to response.* events", () => {
    const state = createResponsesStreamState("glm-5.2", "resp_test");
    const events = [
      ...chatStreamChunkToResponsesEvents(
        'data: {"id":"c1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
        state,
      ),
      ...chatStreamChunkToResponsesEvents(
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
        state,
      ),
      ...chatStreamChunkToResponsesEvents("data: [DONE]\n\n", state),
      ...finalizeResponsesStream(state),
    ];

    const joined = events.join("");
    expect(joined).toContain("event: response.created");
    expect(joined).toContain("event: response.output_text.delta");
    expect(joined).toContain('"delta":"Hel"');
    expect(joined).toContain('"delta":"lo"');
    expect(joined).toContain("event: response.completed");
    expect(state.text).toBe("Hello");
  });

  test("retains SSE frames split across upstream reads", () => {
    const state = createResponsesStreamState("m", "resp_split");
    const frame = 'data: {"choices":[{"delta":{"content":"split"}}]}\n\n';
    const midpoint = frame.indexOf("split") + 2;
    const first = chatStreamChunkToResponsesEvents(frame.slice(0, midpoint), state);
    const second = chatStreamChunkToResponsesEvents(frame.slice(midpoint), state);
    expect(first).toEqual([]);
    expect(second.join("")).toContain('"delta":"split"');
    expect(state.text).toBe("split");
  });
});
