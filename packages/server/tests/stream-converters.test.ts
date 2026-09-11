import { describe, expect, test } from "bun:test";
import type {
  AnthropicCallArgs,
  BaseProvider,
  ProviderCallContext,
} from "../src/providers/base.ts";
import type { ProviderConfig } from "@model-proxy/contracts/schemas/provider.ts";
import type { ResolvedRoute } from "@model-proxy/contracts/schemas/routing.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { executeStream } from "../src/routing/executor.ts";
import { createStreamConverter } from "../src/format/stream-converters.ts";

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface ParsedSse {
  raw: string[];
  json: Array<Record<string, unknown>>;
  done: boolean;
}

function parseSse(chunks: string[]): ParsedSse {
  const raw: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  let done = false;
  for (const chunk of chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      if (payload.length === 0) continue;
      raw.push(payload);
      try {
        json.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // non-JSON payloads are kept in raw only
      }
    }
  }
  return { raw, json, done };
}

describe("anthropic -> openai stream converter", () => {
  test("converts text, tool calls, stop reason, and usage", () => {
    const converter = createStreamConverter("anthropic", "openai", "glm-4.7");
    const chunks: string[] = [];
    chunks.push(...converter.convert(sseData({
      type: "message_start",
      message: { id: "msg_1", model: "glm-4.7", usage: { input_tokens: 100, output_tokens: 0 } },
    })));
    chunks.push(...converter.convert(`event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`));
    chunks.push(...converter.convert(sseData({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    })));
    chunks.push(...converter.convert(sseData({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "edit_file" },
    })));
    chunks.push(...converter.convert(sseData({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"a" },
    })));
    chunks.push(...converter.convert(sseData({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: ".ts\"}" },
    })));
    chunks.push(...converter.convert(sseData({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 42 },
    })));
    chunks.push(...converter.convert(sseData({ type: "message_stop" })));
    chunks.push(...converter.finalize());

    const parsed = parseSse(chunks);
    expect(parsed.done).toBe(true);
    const first = parsed.json[0]!;
    const firstDelta = (first.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>;
    expect(firstDelta.role).toBe("assistant");
    const contents = parsed.json
      .filter((e) => Array.isArray(e.choices) && (e.choices[0] as Record<string, unknown>).delta !== undefined)
      .map((e) => ((e.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>));
    expect(contents.some((d) => d.content === "hello")).toBe(true);
    const toolStart = contents.find((d) => Array.isArray(d.tool_calls)) as Record<string, unknown> | undefined;
    expect(toolStart).toBeDefined();
    const startCall = (toolStart!.tool_calls as Array<Record<string, unknown>>)[0]!;
    expect(startCall.index).toBe(0);
    expect(startCall.id).toBe("toolu_1");
    expect((startCall.function as Record<string, unknown>).name).toBe("edit_file");
    const argDeltas = contents.filter((d) =>
      Array.isArray(d.tool_calls) &&
      ((d.tool_calls as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>).arguments !== undefined &&
      d !== toolStart,
    );
    const joinedArgs = argDeltas
      .map((d) => ((d.tool_calls as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>).arguments)
      .join("");
    expect(joinedArgs).toBe("{\"path\":\"a.ts\"}");
    const finalChunks = parsed.json.filter((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined;
      return Array.isArray(choices) && choices[0]!.finish_reason !== undefined && choices[0]!.finish_reason !== null;
    });
    expect(finalChunks.length).toBe(1);
    const finalChoices = finalChunks[0]!.choices as Array<Record<string, unknown>>;
    expect(finalChoices[0]!.finish_reason).toBe("tool_calls");
    const usage = finalChunks[0]!.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(42);
    expect(usage.total_tokens).toBe(142);
  });

  test("reassembles SSE lines split across convert calls", () => {
    const converter = createStreamConverter("anthropic", "openai", "m");
    const event = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "split" },
    })}\n\n`;
    const half = Math.floor(event.length / 2);
    const out = [
      ...converter.convert(event.slice(0, half)),
      ...converter.convert(event.slice(half)),
      ...converter.finalize(),
    ];
    const parsed = parseSse(out);
    const contents = parsed.json
      .filter((e) => Array.isArray(e.choices))
      .map((e) => ((e.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>));
    expect(contents.some((d) => d.content === "split")).toBe(true);
  });

  test("maps end_turn to stop and emits [DONE] once on finalize", () => {
    const converter = createStreamConverter("anthropic", "openai", "m");
    const out = [
      ...converter.convert(sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      })),
      ...converter.finalize(),
    ];
    const parsed = parseSse(out);
    expect(parsed.done).toBe(true);
    expect(parsed.json.filter((e) => e.choices !== undefined).length).toBe(1);
    const final = parsed.json.find((e) => e.choices !== undefined)!;
    expect((final.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("stop");
    expect((final.usage as Record<string, unknown>).completion_tokens).toBe(5);
  });
});

describe("openai -> anthropic stream converter", () => {
  test("converts text and tool-call deltas into anthropic blocks", () => {
    const converter = createStreamConverter("openai", "anthropic", "glm-4.7");
    const chunks: string[] = [];
    chunks.push(...converter.convert(sseData({
      id: "chatcmpl_1",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })));
    chunks.push(...converter.convert(sseData({
      id: "chatcmpl_1",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    })));
    chunks.push(...converter.convert(sseData({
      id: "chatcmpl_1",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "edit_file", arguments: "" } }] },
        finish_reason: null,
      }],
    })));
    chunks.push(...converter.convert(sseData({
      id: "chatcmpl_1",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] },
        finish_reason: null,
      }],
    })));
    chunks.push(...converter.convert(sseData({
      id: "chatcmpl_1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
    })));
    chunks.push(...converter.convert("data: [DONE]\n\n"));
    chunks.push(...converter.finalize());

    const types = chunks.map((c) => {
      const dataLine = c.split(/\r?\n/).find((l) => l.startsWith("data:")) ?? "";
      const payload = dataLine.slice(5).trim();
      try {
        return JSON.parse(payload)["type"] as string;
      } catch {
        return "";
      }
    });
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types[types.length - 1]).toBe("message_stop");
    const all = chunks.join("");
    expect(all).toContain("\"type\":\"text_delta\"");
    expect(all).toContain("\"type\":\"input_json_delta\"");
    expect(all).toContain("\"text\":\"hi\"");
    expect(all).toContain("\"type\":\"tool_use\"");
    expect(all).toContain("\"name\":\"edit_file\"");
    const joinedPartialJson = [...all.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`) as string)
      .join("");
    expect(joinedPartialJson).toBe("{\"path\":");
    const messageDelta = chunks.find((c) => c.includes("\"message_delta\""))!;
    expect(messageDelta).toContain("\"stop_reason\":\"tool_use\"");
    expect(messageDelta).toContain("\"output_tokens\":7");
    expect(all).toContain("\"message_stop\"");
  });

  test("emits message_stop when the stream ends without [DONE]", () => {
    const converter = createStreamConverter("openai", "anthropic", "m");
    const out = [
      ...converter.convert(sseData({
        id: "c1",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
      })),
      ...converter.finalize(),
    ];
    expect(out.join("")).toContain("\"message_stop\"");
    expect(out.join("")).toContain("\"stop_reason\":\"end_turn\"");
  });
});

describe("responses -> openai stream converter", () => {
  test("converts function calls and text into chat chunks", () => {
    const converter = createStreamConverter("responses", "openai", "gpt-5");
    const chunks: string[] = [];
    chunks.push(...converter.convert(
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_1", model: "gpt-5", created_at: 1700000000, status: "in_progress" },
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "edit_file", arguments: "" },
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: "{\"x\":1}",
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "done",
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [],
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        },
      })}\n\n`,
    ));
    chunks.push(...converter.finalize());

    const parsed = parseSse(chunks);
    expect(parsed.done).toBe(true);
    const toolStart = parsed.json.find((e) =>
      Array.isArray(e.choices) &&
      Array.isArray(((e.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls),
    )!;
    const call = (((toolStart.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>)[0]!;
    expect(call.id).toBe("call_9");
    expect((call.function as Record<string, unknown>).name).toBe("edit_file");
    const final = parsed.json.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined;
      return Array.isArray(choices) && choices[0]!.finish_reason !== null && choices[0]!.finish_reason !== undefined;
    })!;
    expect((final.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("tool_calls");
    expect((final.usage as Record<string, unknown>).prompt_tokens).toBe(12);
  });
});

describe("responses -> anthropic stream converter", () => {
  test("produces message_start, tool_use blocks, and message_stop", () => {
    const converter = createStreamConverter("responses", "anthropic", "gpt-5");
    const chunks: string[] = [];
    chunks.push(...converter.convert(
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_2", model: "gpt-5", status: "in_progress" },
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "search_replace", arguments: "" },
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_2",
        delta: "{\"q\":1}",
      })}\n\n`,
    ));
    chunks.push(...converter.convert(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_2", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
      })}\n\n`,
    ));
    chunks.push(...converter.finalize());
    const all = chunks.join("");
    expect(all).toContain("\"message_start\"");
    expect(all).toContain("\"type\":\"tool_use\"");
    expect(all).toContain("\"name\":\"search_replace\"");
    expect(all).toContain("\"partial_json\":\"{\\\"q\\\":1}\"");
    expect(all).toContain("\"stop_reason\":\"tool_use\"");
    expect(all).toContain("\"message_stop\"");
  });
});

const providerConfig = {} as ProviderConfig;

class AnthropicStreamFake implements BaseProvider {
  readonly providerName = "anthropic-stream-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "anthropic" as const;
  async callAnthropic(_args: AnthropicCallArgs, _ctx: ProviderCallContext): Promise<Record<string, unknown>> {
    throw new Error("not used");
  }  async *streamAnthropic(_args: AnthropicCallArgs, _ctx: ProviderCallContext): AsyncGenerator<string> {
    yield `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_x", model: "upstream-model", usage: { input_tokens: 9, output_tokens: 0 } },
    })}\n\n`;
    yield "event: content_block_start\n";
    yield `data: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_x", name: "edit_file" },
    })}\n\n`;
    yield `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"file\":\"a.ts\"}" },
    })}\n\n`;
    yield `data: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3 },
    })}\n\n`;
    yield `data: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  }
}

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

describe("executeStream cross-protocol conversion", () => {
  const providerName = "anthropic-stream-fake";
  providerRegistry.registerProvider(providerName, () => new AnthropicStreamFake());

  test("openai client receives chat chunks from an anthropic-wire route", async () => {
    const chunks: string[] = [];
    for await (const chunk of executeStream({
      route: route(providerName, "anthropic"),
      requestData: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }
    const parsed = parseSse(chunks);
    expect(parsed.done).toBe(true);
    const toolStart = parsed.json.find((e) =>
      Array.isArray(e.choices) &&
      Array.isArray(((e.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls),
    );
    expect(toolStart).toBeDefined();
    const call = (((toolStart!.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>)[0]!;
    expect((call.function as Record<string, unknown>).name).toBe("edit_file");
    const final = parsed.json.find((e) => {
      const choices = e.choices as Array<Record<string, unknown>> | undefined;
      return Array.isArray(choices) && choices[0]!.finish_reason !== null && choices[0]!.finish_reason !== undefined;
    })!;
    expect((final.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe("tool_calls");
    expect((final.usage as Record<string, unknown>).prompt_tokens).toBe(9);
  });

  test("anthropic client receives anthropic events unchanged (identity passthrough)", async () => {
    const chunks: string[] = [];
    for await (const chunk of executeStream({
      route: route(providerName, "anthropic"),
      requestData: { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true },
      targetProtocol: "anthropic",
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toContain("\"message_start\"");
  });
});
