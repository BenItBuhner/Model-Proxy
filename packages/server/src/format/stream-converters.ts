/**
 * Cross-protocol SSE stream converters: OpenAI <-> Anthropic <-> Responses.
 * Used by the routing executor when a route's wire protocol differs from the
 * client-facing protocol, so streamed text, reasoning, and tool calls survive
 * the protocol hop instead of leaking raw upstream frames to the client.
 */
import { isObject } from "../shared/utils.ts";
import { mergeAnthropicUsageIntoChatUsage } from "./responses.ts";

export type WireProtocol = "openai" | "anthropic" | "responses";

export interface StreamConverter {
  /** Convert one upstream SSE chunk into zero or more client SSE chunks. */
  convert(chunk: string): string[];
  /** Flush terminal frames (finish_reason/usage/[DONE] or message_stop). */
  finalize(): string[];
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return dataLine({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function forEachDataLine(chunk: string, buffer: { sse: string }, fn: (payload: string) => void): void {
  buffer.sse += chunk;
  const lines = buffer.sse.split(/\r?\n/);
  buffer.sse = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    fn(payload);
  }
}

function parsePayload(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface AnthropicToOpenAIState {
  sse: string;
  id: string;
  created: number;
  model: string;
  roleEmitted: boolean;
  toolIndexByBlock: Map<number, number>;
  nextToolIndex: number;
  sawToolCalls: boolean;
  finishReason: string | null;
  usage: Record<string, unknown> | undefined;
  finished: boolean;
}

function anthropicStopReasonToFinishReason(stopReason: unknown): string {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function emitFinalOpenAIChunk(state: AnthropicToOpenAIState): string[] {
  if (state.finished) return [];
  state.finished = true;
  const finishReason = state.finishReason ?? (state.sawToolCalls ? "tool_calls" : "stop");
  const chunk: Record<string, unknown> = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (state.usage !== undefined) chunk["usage"] = state.usage;
  return [dataLine(chunk), "data: [DONE]\n\n"];
}

function createAnthropicToOpenAIConverter(model: string): StreamConverter {
  const state: AnthropicToOpenAIState = {
    sse: "",
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    roleEmitted: false,
    toolIndexByBlock: new Map(),
    nextToolIndex: 0,
    sawToolCalls: false,
    finishReason: null,
    usage: undefined,
    finished: false,
  };
  const roleChunk = (): string => {
    if (state.roleEmitted) return "";
    state.roleEmitted = true;
    return chatChunk(state.id, state.created, state.model, { role: "assistant", content: "" });
  };
  return {
    convert(chunk: string): string[] {
      const out: string[] = [];
      forEachDataLine(chunk, state, (payload) => {
        const parsed = parsePayload(payload);
        if (parsed === undefined) return;
        const type = asString(parsed["type"]);
        if (type === "message_start") {
          const message = isObject(parsed["message"]) ? parsed["message"] : {};
          if (typeof message["id"] === "string" && message["id"].length > 0) state.id = message["id"];
          if (typeof message["model"] === "string" && message["model"].length > 0) state.model = message["model"];
          const startUsage = isObject(message["usage"]) ? message["usage"] : undefined;
          if (startUsage !== undefined) state.usage = mergeAnthropicUsageIntoChatUsage(startUsage, state.usage);
          out.push(roleChunk());
          return;
        }
        if (type === "content_block_start") {
          const block = isObject(parsed["content_block"]) ? parsed["content_block"] : {};
          if (block["type"] === "tool_use") {
            const blockIndex = typeof parsed["index"] === "number" ? parsed["index"] : 0;
            const toolIndex = state.nextToolIndex++;
            state.toolIndexByBlock.set(blockIndex, toolIndex);
            state.sawToolCalls = true;
            out.push(roleChunk());
            out.push(chatChunk(state.id, state.created, state.model, {
              tool_calls: [{
                index: toolIndex,
                id: typeof block["id"] === "string" && block["id"].length > 0 ? block["id"] : `call_${toolIndex}`,
                type: "function",
                function: { name: asString(block["name"]), arguments: "" },
              }],
            }));
          }
          return;
        }
        if (type === "content_block_delta") {
          const delta = isObject(parsed["delta"]) ? parsed["delta"] : {};
          if (typeof delta["text"] === "string" && delta["text"].length > 0) {
            out.push(roleChunk());
            out.push(chatChunk(state.id, state.created, state.model, { content: delta["text"] }));
          }
          if (typeof delta["thinking"] === "string" && delta["thinking"].length > 0) {
            out.push(chatChunk(state.id, state.created, state.model, { reasoning_content: delta["thinking"] }));
          }
          if (typeof delta["partial_json"] === "string" && delta["partial_json"].length > 0) {
            const blockIndex = typeof parsed["index"] === "number" ? parsed["index"] : 0;
            let toolIndex = state.toolIndexByBlock.get(blockIndex);
            if (toolIndex === undefined) {
              toolIndex = state.nextToolIndex++;
              state.toolIndexByBlock.set(blockIndex, toolIndex);
              state.sawToolCalls = true;
            }
            out.push(chatChunk(state.id, state.created, state.model, {
              tool_calls: [{ index: toolIndex, function: { arguments: delta["partial_json"] } }],
            }));
          }
          return;
        }
        if (type === "message_delta") {
          const delta = isObject(parsed["delta"]) ? parsed["delta"] : {};
          if (typeof delta["stop_reason"] === "string") {
            state.finishReason = anthropicStopReasonToFinishReason(delta["stop_reason"]);
          }
          const usage = isObject(parsed["usage"]) ? parsed["usage"] : undefined;
          if (usage !== undefined) state.usage = mergeAnthropicUsageIntoChatUsage(usage, state.usage);
          return;
        }
        if (type === "message_stop") {
          out.push(...emitFinalOpenAIChunk(state));
          return;
        }
        if (type === "error") {
          out.push(dataLine({ error: parsed["error"] ?? parsed }));
          state.finished = true;
        }
      });
      return out;
    },
    finalize(): string[] {
      return emitFinalOpenAIChunk(state);
    },
  };
}

interface OpenAIToAnthropicState {
  sse: string;
  id: string;
  model: string;
  started: boolean;
  nextBlockIndex: number;
  textBlock: number | undefined;
  thinkingBlock: number | undefined;
  toolBlocks: Map<number, number>;
  sawToolCalls: boolean;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  finished: boolean;
}

function openAIFinishToStopReason(reason: unknown): string | null {
  if (typeof reason !== "string" || reason.length === 0) return null;
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function createOpenAIToAnthropicConverter(model: string): StreamConverter {
  const state: OpenAIToAnthropicState = {
    sse: "",
    id: newId("msg"),
    model,
    started: false,
    nextBlockIndex: 0,
    textBlock: undefined,
    thinkingBlock: undefined,
    toolBlocks: new Map(),
    sawToolCalls: false,
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0,
    finished: false,
  };
  const anthropicEvent = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const ensureStarted = (out: string[]): void => {
    if (state.started) return;
    state.started = true;
    out.push(anthropicEvent("message_start", {
      message: {
        id: state.id,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    }));
  };
  const openBlock = (out: string[], contentBlock: Record<string, unknown>): number => {
    const index = state.nextBlockIndex++;
    out.push(anthropicEvent("content_block_start", { index, content_block: contentBlock }));
    return index;
  };
  const closeBlock = (out: string[], index: number | undefined): void => {
    if (index === undefined) return;
    out.push(anthropicEvent("content_block_stop", { index }));
  };
  const finalizeInner = (out: string[]): void => {
    if (state.finished) return;
    state.finished = true;
    if (state.started) {
      closeBlock(out, state.thinkingBlock);
      closeBlock(out, state.textBlock);
      for (const blockIndex of state.toolBlocks.values()) closeBlock(out, blockIndex);
      out.push(anthropicEvent("message_delta", {
        delta: {
          stop_reason: state.stopReason ?? (state.sawToolCalls ? "tool_use" : "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: state.outputTokens },
      }));
      out.push(anthropicEvent("message_stop", {}));
    }
  };
  return {
    convert(chunk: string): string[] {
      const out: string[] = [];
      forEachDataLine(chunk, state, (payload) => {
        if (state.finished) return;
        const parsed = parsePayload(payload);
        if (parsed === undefined) return;
        if (isObject(parsed["error"])) {
          ensureStarted(out);
          out.push(anthropicEvent("error", { error: parsed["error"] }));
          state.finished = true;
          return;
        }
        if (isObject(parsed["usage"])) {
          const usage = parsed["usage"] as Record<string, unknown>;
          if (typeof usage["prompt_tokens"] === "number") state.inputTokens = usage["prompt_tokens"];
          if (typeof usage["completion_tokens"] === "number") state.outputTokens = usage["completion_tokens"];
        }
        if (typeof parsed["model"] === "string" && parsed["model"].length > 0) {
          state.model = parsed["model"];
        }
        const choices = Array.isArray(parsed["choices"]) ? parsed["choices"] : [];
        const choice = isObject(choices[0]) ? choices[0] : undefined;
        if (choice === undefined) return;
        ensureStarted(out);
        const delta = isObject(choice["delta"]) ? choice["delta"] : {};
        if (typeof delta["content"] === "string" && delta["content"].length > 0) {
          if (state.textBlock === undefined) {
            state.textBlock = openBlock(out, { type: "text", text: "" });
          }
          out.push(anthropicEvent("content_block_delta", {
            index: state.textBlock,
            delta: { type: "text_delta", text: delta["content"] },
          }));
        }
        for (const field of ["reasoning_content", "reasoning"]) {
          if (typeof delta[field] === "string" && (delta[field] as string).length > 0) {
            if (state.thinkingBlock === undefined) {
              state.thinkingBlock = openBlock(out, { type: "thinking", thinking: "" });
            }
            out.push(anthropicEvent("content_block_delta", {
              index: state.thinkingBlock,
              delta: { type: "thinking_delta", thinking: delta[field] },
            }));
            break;
          }
        }
        if (Array.isArray(delta["tool_calls"])) {
          for (const raw of delta["tool_calls"]) {
            if (!isObject(raw)) continue;
            const index = typeof raw["index"] === "number" ? raw["index"] : 0;
            let blockIndex = state.toolBlocks.get(index);
            if (blockIndex === undefined) {
              const fn = isObject(raw["function"]) ? raw["function"] : {};
              blockIndex = openBlock(out, {
                type: "tool_use",
                id: typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : newId("toolu"),
                name: asString(fn["name"]),
              });
              state.toolBlocks.set(index, blockIndex);
              state.sawToolCalls = true;
            }
            const fn = isObject(raw["function"]) ? raw["function"] : {};
            if (typeof fn["arguments"] === "string" && fn["arguments"].length > 0) {
              out.push(anthropicEvent("content_block_delta", {
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: fn["arguments"] },
              }));
            }
          }
        }
        const stopReason = openAIFinishToStopReason(choice["finish_reason"]);
        if (stopReason !== null) state.stopReason = stopReason;
      });
      return out;
    },
    finalize(): string[] {
      const out: string[] = [];
      finalizeInner(out);
      return out;
    },
  };
}

interface ResponsesToOpenAIState {
  sse: string;
  id: string;
  created: number;
  model: string;
  roleEmitted: boolean;
  toolIndexByItem: Map<string, number>;
  nextToolIndex: number;
  sawToolCalls: boolean;
  finished: boolean;
}

function createResponsesToOpenAIConverter(model: string): StreamConverter {
  const state: ResponsesToOpenAIState = {
    sse: "",
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    roleEmitted: false,
    toolIndexByItem: new Map(),
    nextToolIndex: 0,
    sawToolCalls: false,
    finished: false,
  };
  const roleChunk = (): string => {
    if (state.roleEmitted) return "";
    state.roleEmitted = true;
    return chatChunk(state.id, state.created, state.model, { role: "assistant", content: "" });
  };
  const finalizeChunk = (usage: Record<string, unknown> | undefined, finishReason: string): string[] => {
    if (state.finished) return [];
    state.finished = true;
    const chunk: Record<string, unknown> = {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (usage !== undefined) {
      const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
      const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
      chunk["usage"] = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : inputTokens + outputTokens,
      };
    }
    return [dataLine(chunk), "data: [DONE]\n\n"];
  };
  return {
    convert(chunk: string): string[] {
      const out: string[] = [];
      forEachDataLine(chunk, state, (payload) => {
        if (state.finished) return;
        const parsed = parsePayload(payload);
        if (parsed === undefined) return;
        const type = asString(parsed["type"]);
        if (type === "response.created" || type === "response.in_progress") {
          const response = isObject(parsed["response"]) ? parsed["response"] : {};
          if (typeof response["id"] === "string" && response["id"].length > 0) state.id = response["id"];
          if (typeof response["model"] === "string" && response["model"].length > 0) state.model = response["model"];
          if (typeof response["created_at"] === "number") state.created = response["created_at"];
          out.push(roleChunk());
          return;
        }
        if (type === "response.output_text.delta" || type === "response.refusal.delta") {
          const delta = asString(parsed["delta"]);
          if (delta.length > 0) {
            out.push(roleChunk());
            out.push(chatChunk(state.id, state.created, state.model, { content: delta }));
          }
          return;
        }
        if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
          const delta = asString(parsed["delta"]);
          if (delta.length > 0) {
            out.push(chatChunk(state.id, state.created, state.model, { reasoning_content: delta }));
          }
          return;
        }
        if (type === "response.output_item.added") {
          const item = isObject(parsed["item"]) ? parsed["item"] : {};
          if (asString(item["type"]) === "function_call") {
            const itemId = asString(item["id"]);
            const toolIndex = state.nextToolIndex++;
            state.toolIndexByItem.set(itemId, toolIndex);
            state.sawToolCalls = true;
            out.push(roleChunk());
            out.push(chatChunk(state.id, state.created, state.model, {
              tool_calls: [{
                index: toolIndex,
                id: asString(item["call_id"]) || `call_${toolIndex}`,
                type: "function",
                function: { name: asString(item["name"]), arguments: "" },
              }],
            }));
          }
          return;
        }
        if (type === "response.function_call_arguments.delta") {
          const itemId = asString(parsed["item_id"]);
          const toolIndex = state.toolIndexByItem.get(itemId) ?? Math.max(0, state.nextToolIndex - 1);
          const delta = asString(parsed["delta"]);
          if (delta.length > 0) {
            out.push(chatChunk(state.id, state.created, state.model, {
              tool_calls: [{ index: toolIndex, function: { arguments: delta } }],
            }));
          }
          return;
        }
        if (type === "response.completed" || type === "response.incomplete") {
          const response = isObject(parsed["response"]) ? parsed["response"] : {};
          const usage = isObject(response["usage"]) ? (response["usage"] as Record<string, unknown>) : undefined;
          const sawAnyTool = state.sawToolCalls || (Array.isArray(response["output"]) &&
            (response["output"] as unknown[]).some((entry) => isObject(entry) && entry["type"] === "function_call"));
          out.push(...finalizeChunk(usage, asString(response["status"]) === "incomplete" ? "length" : sawAnyTool ? "tool_calls" : "stop"));
        }
      });
      return out;
    },
    finalize(): string[] {
      return finalizeChunk(undefined, state.sawToolCalls ? "tool_calls" : "stop");
    },
  };
}

function createResponsesToAnthropicConverter(model: string): StreamConverter {
  const toOpenAI = createResponsesToOpenAIConverter(model);
  const toAnthropic = createOpenAIToAnthropicConverter(model);
  return {
    convert(chunk: string): string[] {
      const out: string[] = [];
      for (const openAIChunk of toOpenAI.convert(chunk)) {
        out.push(...toAnthropic.convert(openAIChunk));
      }
      return out;
    },
    finalize(): string[] {
      const out: string[] = [];
      for (const openAIChunk of toOpenAI.finalize()) {
        out.push(...toAnthropic.convert(openAIChunk));
      }
      out.push(...toAnthropic.finalize());
      return out;
    },
  };
}

/** Build the converter for a cross-protocol stream; identity protocols pass chunks through. */
export function createStreamConverter(
  from: WireProtocol,
  to: WireProtocol,
  model: string,
): StreamConverter {
  if (from === to) {
    return { convert: (chunk) => [chunk], finalize: () => [] };
  }
  if (from === "anthropic" && to === "openai") return createAnthropicToOpenAIConverter(model);
  if (from === "responses" && to === "openai") return createResponsesToOpenAIConverter(model);
  if (from === "openai" && to === "anthropic") return createOpenAIToAnthropicConverter(model);
  if (from === "responses" && to === "anthropic") return createResponsesToAnthropicConverter(model);
  return { convert: (chunk) => [chunk], finalize: () => [] };
}
