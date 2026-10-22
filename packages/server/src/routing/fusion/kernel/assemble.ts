import { parseOpenAIDelta, splitSseEvents } from "../reasoning-summarizer.ts";

/**
 * Assemble a complete chat response from an SSE stream (OpenAI or Anthropic
 * dialect). The kernel always streams upstream — even for non-streaming
 * clients — because long thinking-model generations behind CDN/origin
 * timeouts (Cloudflare 524 at 100s) only survive when bytes keep flowing.
 */

export interface AssembledResponse {
  content: string | null;
  reasoningContent?: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** True when the stream ended without any content, tool call, or finish signal. */
  empty: boolean;
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
}

export async function assembleStream(
  stream: AsyncIterable<string>,
  protocol: "openai" | "anthropic",
): Promise<AssembledResponse> {
  return protocol === "anthropic" ? assembleAnthropic(stream) : assembleOpenAI(stream);
}

async function assembleOpenAI(stream: AsyncIterable<string>): Promise<AssembledResponse> {
  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: AssembledResponse["usage"];
  const tools = new Map<number, ToolAcc>();
  let sawAnything = false;

  for await (const raw of stream) {
    for (const event of splitSseEvents(raw)) {
      const parsed = parseOpenAIDelta(event);
      if (parsed === null) continue;
      sawAnything = true;
      if (parsed.content.length > 0) content += parsed.content;
      if (parsed.reasoning.length > 0) reasoning += parsed.reasoning;
      if (parsed.finishReason !== undefined) finishReason = parsed.finishReason;
      for (const delta of parsed.toolCallDeltas) {
        const index = typeof delta["index"] === "number" ? (delta["index"] as number) : tools.size;
        const acc = tools.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof delta["id"] === "string" && (delta["id"] as string).length > 0) acc.id = delta["id"] as string;
        const fn = delta["function"] as Record<string, unknown> | undefined;
        if (typeof fn?.["name"] === "string" && (fn["name"] as string).length > 0) acc.name += fn["name"] as string;
        if (typeof fn?.["arguments"] === "string") acc.arguments += fn["arguments"] as string;
        tools.set(index, acc);
      }
      const usageObj = parsed.chunk["usage"] as Record<string, unknown> | undefined | null;
      if (usageObj !== undefined && usageObj !== null && typeof usageObj === "object") {
        usage = {
          promptTokens: Number(usageObj["prompt_tokens"] ?? 0),
          completionTokens: Number(usageObj["completion_tokens"] ?? 0),
          totalTokens: Number(usageObj["total_tokens"] ?? 0),
        };
      }
    }
  }

  const toolCalls = [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, acc]) => ({
      id: acc.id.length > 0 ? acc.id : `call_${index}`,
      type: "function",
      function: { name: acc.name, arguments: acc.arguments.length > 0 ? acc.arguments : "{}" },
    }))
    .filter((tc) => tc.function.name.length > 0);

  return {
    content: toolCalls.length > 0 && content.length === 0 ? null : content,
    reasoningContent: reasoning.length > 0 ? reasoning : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: finishReason ?? (toolCalls.length > 0 ? "tool_calls" : sawAnything ? "stop" : undefined),
    usage,
    empty: !sawAnything || (content.length === 0 && toolCalls.length === 0 && finishReason === undefined),
  };
}

async function assembleAnthropic(stream: AsyncIterable<string>): Promise<AssembledResponse> {
  let content = "";
  let thinking = "";
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  let sawAnything = false;

  for await (const raw of stream) {
    for (const event of splitSseEvents(raw)) {
      const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine === undefined) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataLine.replace(/^data:\s?/, "")) as Record<string, unknown>;
      } catch {
        continue;
      }
      sawAnything = true;
      const type = payload["type"];
      if (type === "message_start") {
        const usage = (payload["message"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined;
        inputTokens = Number(usage?.["input_tokens"] ?? 0);
        continue;
      }
      if (type === "content_block_start") {
        const index = Number(payload["index"] ?? blocks.size);
        const block = payload["content_block"] as Record<string, unknown> | undefined;
        blocks.set(index, {
          type: String(block?.["type"] ?? "text"),
          id: typeof block?.["id"] === "string" ? (block["id"] as string) : undefined,
          name: typeof block?.["name"] === "string" ? (block["name"] as string) : undefined,
          json: block?.["input"] !== undefined && Object.keys(block["input"] as object).length > 0 ? JSON.stringify(block["input"]) : "",
        });
        if (block?.["type"] === "text" && typeof block["text"] === "string") content += block["text"] as string;
        continue;
      }
      if (type === "content_block_delta") {
        const index = Number(payload["index"] ?? 0);
        const delta = payload["delta"] as Record<string, unknown> | undefined;
        if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") content += delta["text"] as string;
        else if (delta?.["type"] === "thinking_delta" && typeof delta["thinking"] === "string") thinking += delta["thinking"] as string;
        else if (delta?.["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
          const block = blocks.get(index);
          if (block !== undefined) block.json += delta["partial_json"] as string;
        }
        continue;
      }
      if (type === "message_delta") {
        const delta = payload["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["stop_reason"] === "string") stopReason = delta["stop_reason"] as string;
        const usage = payload["usage"] as Record<string, unknown> | undefined;
        if (usage !== undefined) outputTokens = Math.max(outputTokens, Number(usage["output_tokens"] ?? 0));
      }
    }
  }

  const toolCalls = [...blocks.entries()]
    .filter(([, b]) => b.type === "tool_use" && b.name !== undefined)
    .sort(([a], [b]) => a - b)
    .map(([index, b]) => {
      let input: unknown = {};
      try {
        input = b.json.length > 0 ? JSON.parse(b.json) : {};
      } catch {
        input = {};
      }
      return { type: "tool_use", id: b.id ?? `toolu_${index}`, name: b.name, input };
    });

  const finishReason = stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : stopReason !== undefined ? "stop" : toolCalls.length > 0 ? "tool_calls" : sawAnything ? "stop" : undefined;
  return {
    content: toolCalls.length > 0 && content.length === 0 ? null : content,
    reasoningContent: thinking.length > 0 ? thinking : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage: inputTokens > 0 || outputTokens > 0 ? { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens } : undefined,
    empty: !sawAnything || (content.length === 0 && toolCalls.length === 0 && stopReason === undefined),
  };
}
