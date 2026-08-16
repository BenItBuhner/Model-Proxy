import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import type {
  BaseProvider,
  ProviderCallContext,
  OpenAICallArgs,
  AnthropicCallArgs,
  ResponsesCallArgs,
} from "../src/providers/base.ts";
import type { ProviderConfig } from "../shared/schemas/provider.ts";
import type { ResolvedRoute } from "../shared/schemas/routing.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { execute, executeStream } from "../src/routing/executor.ts";
import { responsesRequestToChat } from "../src/format/responses.ts";

const providerConfig = {} as ProviderConfig;

function route(provider: string, wireProtocol: ResolvedRoute["wireProtocol"]): ResolvedRoute {
  return {
    sourceLogicalModel: "test-model",
    wireProtocol,
    provider,
    model: "upstream-model",
    baseUrl: undefined,
    apiKey: "test-key",
    apiKeyEnvVar: "TEST_KEY",
    timeoutSeconds: 10,
    cooldownSeconds: 1,
  };
}

class NativeResponsesFake implements BaseProvider {
  readonly providerName = "native-responses-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "responses" as const;
  static calls: ResponsesCallArgs[] = [];
  static streams: string[][] = [];

  async callResponses(args: ResponsesCallArgs, _ctx: ProviderCallContext) {
    NativeResponsesFake.calls.push(args);
    return {
      id: "resp_native",
      object: "response",
      created_at: 1700000000,
      status: "completed",
      model: args.model,
      output: [{
        type: "message",
        id: "msg_native",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "native answer", annotations: [] }],
      }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      output_text: "native answer",
    };
  }

  async *streamResponses(args: ResponsesCallArgs, _ctx: ProviderCallContext) {
    NativeResponsesFake.calls.push(args);
    const chunks = NativeResponsesFake.streams.shift() ?? [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream","status":"in_progress"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"native"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","output":[]}}\n\n',
    ];
    for (const chunk of chunks) yield chunk;
  }
}

class OpenAIFake implements BaseProvider {
  readonly providerName = "openai-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "openai" as const;
  static calls: OpenAICallArgs[] = [];

  async callOpenAI(args: OpenAICallArgs, _ctx: ProviderCallContext) {
    OpenAIFake.calls.push(args);
    return {
      id: "chatcmpl_fake",
      object: "chat.completion",
      created: 1700000000,
      model: args.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "converted answer" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
  }

  async *streamOpenAI(args: OpenAICallArgs, _ctx: ProviderCallContext) {
    OpenAIFake.calls.push(args);
    yield 'data: {"id":"chatcmpl_fake","choices":[{"delta":{"content":"converted"}}]}\n\n';
    yield 'data: {"id":"chatcmpl_fake","choices":[{"delta":{"content":" stream"},"finish_reason":"stop"}]}\n\n';
    yield "data: [DONE]\n\n";
  }
}

class AnthropicFake implements BaseProvider {
  readonly providerName = "anthropic-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "anthropic" as const;
  static calls: AnthropicCallArgs[] = [];

  async callAnthropic(args: AnthropicCallArgs, _ctx: ProviderCallContext) {
    AnthropicFake.calls.push(args);
    if (Array.isArray(args.tools) && args.tools.length > 0) {
      const first = args.tools[0] as Record<string, unknown>;
      return {
        id: "msg_fake_tool",
        type: "message",
        role: "assistant",
        model: args.model,
        content: [{
          type: "tool_use",
          id: "call_anthropic_tool",
          name: first["name"],
          input: { duration_ms: 10 },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 4, output_tokens: 2 },
      };
    }
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: args.model,
      content: [{ type: "text", text: "anthropic answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 2 },
    };
  }

  async *streamAnthropic(args: AnthropicCallArgs, _ctx: ProviderCallContext) {
    AnthropicFake.calls.push(args);
    yield 'data: {"type":"message_start","message":{"model":"upstream-model"}}\n\n';
    yield 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic stream"}}\n\n';
    yield 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"output_tokens":3}}\n\n';
    yield 'data: {"type":"message_stop"}\n\n';
  }
}

providerRegistry.registerProvider("native-responses-fake", () => new NativeResponsesFake());
providerRegistry.registerProvider("openai-fake", () => new OpenAIFake());
providerRegistry.registerProvider("anthropic-fake", () => new AnthropicFake());

afterAll(() => {
  providerRegistry.unregisterProvider("native-responses-fake");
  providerRegistry.unregisterProvider("openai-fake");
  providerRegistry.unregisterProvider("anthropic-fake");
});

beforeEach(() => {
  NativeResponsesFake.calls = [];
  NativeResponsesFake.streams = [];
  OpenAIFake.calls = [];
  AnthropicFake.calls = [];
});

describe("native Responses protocol routing", () => {
  test("calls a native Responses provider without translating the request", async () => {
    const request = {
      model: "logical-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      instructions: "Be concise",
      reasoning: { effort: "high" },
      text: { format: { type: "text" } },
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    };
    const response = await execute({
      route: route("native-responses-fake", "responses"),
      requestData: request,
      targetProtocol: "responses",
    });
    expect(response.object).toBe("response");
    expect(response.output_text).toBe("native answer");
    expect(NativeResponsesFake.calls[0]).toMatchObject({
      ...request,
      model: "upstream-model",
    });
  });

  test("converts Responses requests for OpenAI providers", async () => {
    const response = await execute({
      route: route("openai-fake", "openai"),
      requestData: {
        model: "logical-model",
        input: [
          { type: "message", role: "user", content: "use lookup" },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
        max_output_tokens: 42,
        seed: 7,
        prompt_cache_key: "cache-key",
        parallel_tool_calls: false,
        reasoning: { effort: "medium" },
      },
      targetProtocol: "responses",
    });
    expect(response.object).toBe("response");
    expect(response.output_text).toBe("converted answer");
    expect(OpenAIFake.calls[0]?.messages).toEqual([
      { role: "user", content: "use lookup" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);
    expect(OpenAIFake.calls[0]?.max_tokens).toBe(42);
    expect(OpenAIFake.calls[0]?.seed).toBe(7);
    expect(OpenAIFake.calls[0]?.prompt_cache_key).toBe("cache-key");
    expect(OpenAIFake.calls[0]?.parallel_tool_calls).toBe(false);
    expect(OpenAIFake.calls[0]?.reasoning).toEqual({ effort: "medium" });
  });

  test("converts Responses requests and responses for Anthropic providers", async () => {
    const response = await execute({
      route: route("anthropic-fake", "anthropic"),
      requestData: { model: "logical-model", input: "hello", max_output_tokens: 50 },
      targetProtocol: "responses",
    });
    expect(response.object).toBe("response");
    expect(response.output_text).toBe("anthropic answer");
    expect(AnthropicFake.calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(AnthropicFake.calls[0]?.max_tokens).toBe(50);
  });

  test("round-trips namespace tools through an Anthropic provider", async () => {
    const response = await execute({
      route: route("anthropic-fake", "anthropic"),
      requestData: {
        model: "logical-model",
        input: "sleep",
        tool_choice: "auto",
        tools: [{
          type: "namespace",
          name: "clock",
          description: "Time tools.",
          tools: [{
            type: "function",
            name: "sleep",
            description: "Pause.",
            parameters: { type: "object", properties: { duration_ms: { type: "number" } } },
          }],
        }],
      },
      targetProtocol: "responses",
    });
    expect(AnthropicFake.calls[0]?.tools).toEqual([expect.objectContaining({
      name: "clock__sleep",
      description: "Time tools.\n\nPause.",
    })]);
    expect(AnthropicFake.calls[0]?.tool_choice).toEqual({ type: "auto" });
    expect(response["output"]).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "call_anthropic_tool",
      namespace: "clock",
      name: "sleep",
      arguments: '{"duration_ms":10}',
    }));
  });

  test("converts OpenAI streaming into Responses events", async () => {
    const chunks: string[] = [];
    for await (const chunk of executeStream({
      route: route("openai-fake", "openai"),
      requestData: { model: "logical-model", input: "hello", stream: true },
      targetProtocol: "responses",
    })) chunks.push(chunk);
    const output = chunks.join("");
    expect(output).toContain("response.created");
    expect(output).toContain("response.output_text.delta");
    expect(output).toContain("converted");
    expect(output).toContain("response.completed");
  });

  test("converts Anthropic streaming into Responses events", async () => {
    const chunks: string[] = [];
    for await (const chunk of executeStream({
      route: route("anthropic-fake", "anthropic"),
      requestData: { model: "logical-model", input: "hello", stream: true },
      targetProtocol: "responses",
    })) chunks.push(chunk);
    const output = chunks.join("");
    expect(output).toContain("response.created");
    expect(output).toContain("anthropic stream");
    expect(output).toContain("response.completed");
  });

  test("passes native Responses streaming events through unchanged", async () => {
    const chunks: string[] = [];
    for await (const chunk of executeStream({
      route: route("native-responses-fake", "responses"),
      requestData: { model: "logical-model", input: "hello", stream: true },
      targetProtocol: "responses",
    })) chunks.push(chunk);
    expect(chunks.join("")).toContain("response.output_text.delta");
  });
});

describe("Responses input conversion coverage", () => {
  test("preserves instructions, multimodal input, and tool definitions", () => {
    const converted = responsesRequestToChat({
      model: "m",
      instructions: "system",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "https://example.com/image.png" },
        ],
      }],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    const messages = converted.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "system" });
    expect(messages[1]?.["role"]).toBe("user");
    expect(converted.tools).toEqual([{
      type: "function",
      function: { name: "lookup", parameters: { type: "object" } },
    }]);
  });
});
