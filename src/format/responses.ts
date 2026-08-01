/**
 * OpenAI Responses API <-> Chat Completions adapter.
 *
 * Translates Codex/OpenAI Responses wire format into the proxy's internal
 * chat-completions pipeline and maps results back to Responses shapes.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function extractTextFromContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asString(content);

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    const type = asString(part["type"]);
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      type === "input_text_delta" ||
      type === "output_text_delta"
    ) {
      parts.push(asString(part["text"] ?? part["content"] ?? ""));
      continue;
    }
    if (typeof part["text"] === "string") {
      parts.push(part["text"]);
    }
  }
  return parts.join("");
}

function contentPartsToChat(content: unknown): string | Array<Record<string, unknown>> | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asString(content);

  const parts: Array<Record<string, unknown>> = [];
  let plain = "";
  let allText = true;

  for (const part of content) {
    if (typeof part === "string") {
      plain += part;
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!isObject(part)) {
      const text = asString(part);
      plain += text;
      parts.push({ type: "text", text });
      continue;
    }

    const type = asString(part["type"]);
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      type === ""
    ) {
      const text = asString(part["text"] ?? part["content"] ?? "");
      plain += text;
      parts.push({ type: "text", text });
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      allText = false;
      const imageUrl = isObject(part["image_url"])
        ? part["image_url"]
        : { url: asString(part["image_url"] ?? part["url"] ?? "") };
      parts.push({ type: "image_url", image_url: imageUrl });
      continue;
    }

    // Unknown structured part: keep as text dump so nothing is dropped.
    const text = extractTextFromContent(part) || JSON.stringify(part);
    plain += text;
    parts.push({ type: "text", text });
  }

  if (allText) return plain;
  return parts;
}

function normalizeRole(role: unknown): "system" | "user" | "assistant" | "tool" {
  const value = asString(role).toLowerCase();
  if (value === "system" || value === "developer") return "system";
  if (value === "assistant") return "assistant";
  if (value === "tool" || value === "function") return "tool";
  return "user";
}

function toolDefinitionFromResponses(tool: unknown): Record<string, unknown> | undefined {
  if (!isObject(tool)) return undefined;
  const type = asString(tool["type"] || "function");

  if (type === "function") {
    // Chat-style already: { type, function: { name, ... } }
    if (isObject(tool["function"])) {
      return {
        type: "function",
        function: tool["function"],
      };
    }
    // Responses-style: { type: "function", name, description, parameters }
    const name = asString(tool["name"]);
    if (!name) return undefined;
    const fn: Record<string, unknown> = { name };
    if (tool["description"] !== undefined) fn["description"] = tool["description"];
    if (tool["parameters"] !== undefined) fn["parameters"] = tool["parameters"];
    if (tool["strict"] !== undefined) fn["strict"] = tool["strict"];
    return { type: "function", function: fn };
  }

  // Pass through other tool types unchanged when possible.
  return tool;
}

function appendInputItem(
  messages: Array<Record<string, unknown>>,
  item: unknown,
): void {
  if (typeof item === "string") {
    const text = item.trim().length > 0 ? item : item;
    messages.push({ role: "user", content: text });
    return;
  }
  if (!isObject(item)) {
    messages.push({ role: "user", content: asString(item) });
    return;
  }

  const type = asString(item["type"]);

  if (type === "message" || type === "" || item["role"] !== undefined) {
    const role = normalizeRole(item["role"] ?? "user");
    const message: Record<string, unknown> = {
      role,
      content: contentPartsToChat(item["content"]),
    };
    if (typeof item["name"] === "string") message["name"] = item["name"];
    if (typeof item["tool_call_id"] === "string") {
      message["tool_call_id"] = item["tool_call_id"];
    }
    if (Array.isArray(item["tool_calls"])) {
      message["tool_calls"] = item["tool_calls"];
    }
    messages.push(message);
    return;
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const callId = asString(item["call_id"] ?? item["id"] ?? newId("call"));
    const name = asString(item["name"]);
    const args =
      typeof item["arguments"] === "string"
        ? item["arguments"]
        : JSON.stringify(item["arguments"] ?? {});
    const toolCall = {
      id: callId,
      type: "function" as const,
      function: { name, arguments: args },
    };
    const last = messages[messages.length - 1];
    if (last !== undefined && last["role"] === "assistant") {
      const existing = Array.isArray(last["tool_calls"])
        ? (last["tool_calls"] as unknown[])
        : [];
      last["tool_calls"] = [...existing, toolCall];
      if (last["content"] === undefined) last["content"] = null;
    } else {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [toolCall],
      });
    }
    return;
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    messages.push({
      role: "tool",
      tool_call_id: asString(item["call_id"] ?? item["id"] ?? ""),
      content: asString(item["output"] ?? item["content"] ?? ""),
    });
    return;
  }

  if (type === "input_text" || type === "output_text" || type === "text") {
    messages.push({
      role: type === "output_text" ? "assistant" : "user",
      content: asString(item["text"] ?? ""),
    });
    return;
  }

  // Fallback: stringify unknown item as a user message.
  messages.push({ role: "user", content: JSON.stringify(item) });
}

export function responsesRequestToChat(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const instructions = request["instructions"];
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  const input = request["input"];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendInputItem(messages, item);
  } else if (isObject(input)) {
    appendInputItem(messages, input);
  } else if (input !== undefined && input !== null) {
    messages.push({ role: "user", content: asString(input) });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const chat: Record<string, unknown> = {
    model: request["model"],
    messages,
  };

  const passthroughKeys = [
    "temperature",
    "top_p",
    "stream",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "user",
    "seed",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "n",
    "logit_bias",
  ] as const;
  for (const key of passthroughKeys) {
    if (request[key] !== undefined) chat[key] = request[key];
  }

  // The Responses text.format object is the semantic equivalent of the
  // Chat Completions response_format object for OpenAI-compatible routes.
  const text = request["text"];
  if (isObject(text) && isObject(text["format"])) {
    chat["response_format"] = text["format"];
  }
  if (request["reasoning"] !== undefined) chat["reasoning"] = request["reasoning"];

  const maxOut = request["max_output_tokens"] ?? request["max_tokens"];
  if (typeof maxOut === "number") {
    chat["max_tokens"] = maxOut;
    chat["max_completion_tokens"] = maxOut;
  }

  if (Array.isArray(request["tools"])) {
    const tools = request["tools"]
      .map((tool) => toolDefinitionFromResponses(tool))
      .filter((tool): tool is Record<string, unknown> =>
        tool !== undefined && asString(tool["type"]) === "function"
      );
    if (tools.length > 0) chat["tools"] = tools;
  }

  return chat;
}

/** Tool types that cannot be represented by the Chat Completions contract. */
export function unsupportedResponsesToolTypes(request: Record<string, unknown>): string[] {
  if (!Array.isArray(request["tools"])) return [];
  return [...new Set(
    request["tools"]
      .filter(isObject)
      .map((tool) => asString(tool["type"] || "function"))
      .filter((type) => type !== "function"),
  )];
}

/** Canonical item history for durable previous_response_id chaining. */
export function responsesInputItemsForStorage(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): unknown[] {
  const input = request["input"];
  const items: unknown[] = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : Array.isArray(input)
      ? [...input]
      : input === undefined || input === null
        ? []
        : [input];
  if (Array.isArray(response["output"])) items.push(...response["output"]);
  return items;
}

function finishReasonToStatus(finishReason: unknown): string {
  const reason = asString(finishReason);
  if (reason === "length" || reason === "max_tokens") return "incomplete";
  return "completed";
}

export function chatResponseToResponses(
  chat: Record<string, unknown>,
  options: {
    model?: string;
    responseId?: string;
    metadata?: Record<string, unknown>;
    parallelToolCalls?: boolean;
  } = {},
): Record<string, unknown> {
  const responseId =
    options.responseId ??
    (typeof chat["id"] === "string" && chat["id"].startsWith("resp_")
      ? chat["id"]
      : newId("resp"));
  const model = options.model ?? asString(chat["model"]);
  const created =
    typeof chat["created"] === "number"
      ? chat["created"]
      : Math.floor(Date.now() / 1000);

  const choices = Array.isArray(chat["choices"]) ? chat["choices"] : [];
  const first = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(first["message"]) ? first["message"] : {};
  const finishReason = first["finish_reason"];
  const status = finishReasonToStatus(finishReason);

  const output: Array<Record<string, unknown>> = [];
  const text = extractTextFromContent(message["content"]);
  const messageId = newId("msg");

  const reasoning =
    typeof message["reasoning_content"] === "string"
      ? message["reasoning_content"]
      : typeof message["reasoning"] === "string"
        ? message["reasoning"]
        : "";
  if (reasoning.length > 0) {
    output.push({
      type: "reasoning",
      id: newId("rsn"),
      status: status === "incomplete" ? "incomplete" : "completed",
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  const refusal = typeof message["refusal"] === "string" ? message["refusal"] : "";

  if (
    text.length > 0 ||
    refusal.length > 0 ||
    !Array.isArray(message["tool_calls"]) ||
    message["tool_calls"].length === 0
  ) {
    const content: Array<Record<string, unknown>> = [];
    if (text.length > 0 || refusal.length === 0) {
      content.push({ type: "output_text", text, annotations: [] });
    }
    if (refusal.length > 0) content.push({ type: "refusal", refusal });
    output.push({
      type: "message",
      id: messageId,
      status: status === "incomplete" ? "incomplete" : "completed",
      role: "assistant",
      content,
    });
  }

  if (Array.isArray(message["tool_calls"])) {
    for (const raw of message["tool_calls"]) {
      if (!isObject(raw)) continue;
      const fn = isObject(raw["function"]) ? raw["function"] : {};
      const callId = asString(raw["id"] || newId("call"));
      output.push({
        type: "function_call",
        id: newId("fc"),
        call_id: callId,
        name: asString(fn["name"]),
        arguments: asString(fn["arguments"] ?? ""),
        status: "completed",
      });
    }
  }

  const usageIn = isObject(chat["usage"]) ? chat["usage"] : {};
  const inputTokens =
    typeof usageIn["prompt_tokens"] === "number" ? usageIn["prompt_tokens"] : 0;
  const outputTokens =
    typeof usageIn["completion_tokens"] === "number"
      ? usageIn["completion_tokens"]
      : 0;
  const totalTokens =
    typeof usageIn["total_tokens"] === "number"
      ? usageIn["total_tokens"]
      : inputTokens + outputTokens;

  const response: Record<string, unknown> = {
    id: responseId,
    object: "response",
    created_at: created,
    status,
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    parallel_tool_calls: true,
  };

  if (options.parallelToolCalls !== undefined) {
    response["parallel_tool_calls"] = options.parallelToolCalls;
  }
  if (options.metadata !== undefined) response["metadata"] = options.metadata;

  const promptDetails = isObject(usageIn["prompt_tokens_details"])
    ? usageIn["prompt_tokens_details"]
    : undefined;
  const completionDetails = isObject(usageIn["completion_tokens_details"])
    ? usageIn["completion_tokens_details"]
    : undefined;
  if (promptDetails !== undefined && typeof promptDetails["cached_tokens"] === "number") {
    (response["usage"] as Record<string, unknown>)["input_tokens_details"] = {
      cached_tokens: promptDetails["cached_tokens"],
    };
  }
  if (completionDetails !== undefined && typeof completionDetails["reasoning_tokens"] === "number") {
    (response["usage"] as Record<string, unknown>)["output_tokens_details"] = {
      reasoning_tokens: completionDetails["reasoning_tokens"],
    };
  }

  // Convenience field used by some clients / debugging.
  if (text.length > 0) {
    response["output_text"] = text;
  }

  return response;
}

export interface ResponsesStreamState {
  responseId: string;
  model: string;
  createdAt: number;
  textItemId: string;
  textContentIndex: number;
  outputIndex: number;
  started: boolean;
  textStarted: boolean;
  text: string;
  toolCalls: Map<
    number,
    { itemId: string; callId: string; name: string; arguments: string; started: boolean }
  >;
  usage: Record<string, unknown> | undefined;
  finishReason: string | null;
  sequence: number;
  /** Partial upstream SSE data retained across fetch reads. */
  sseBuffer: string;
}

export function createResponsesStreamState(
  model: string,
  responseId?: string,
): ResponsesStreamState {
  return {
    responseId: responseId ?? newId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    textItemId: newId("msg"),
    textContentIndex: 0,
    outputIndex: 0,
    started: false,
    textStarted: false,
    text: "",
    toolCalls: new Map(),
    usage: undefined,
    finishReason: null,
    sequence: 0,
    sseBuffer: "",
  };
}

/** Reconstruct a chat-shaped response for persistence after a streamed response. */
export function responsesStreamStateToChatResponse(
  state: ResponsesStreamState,
): Record<string, unknown> {
  const toolCalls = [...state.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => ({
      id: entry.callId,
      type: "function",
      function: { name: entry.name, arguments: entry.arguments },
    }));
  const message: Record<string, unknown> = {
    role: "assistant",
    content: state.text || null,
  };
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  return {
    id: `chatcmpl-${state.responseId}`,
    object: "chat.completion",
    created: state.createdAt,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason ?? "stop",
      },
    ],
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
  };
}

export type ResponsesEvent = Record<string, unknown> & { type: string; sequence_number: number };

function pushEvent(
  state: ResponsesStreamState,
  type: string,
  payload: Record<string, unknown>,
  out: ResponsesEvent[],
): void {
  out.push({
    ...payload,
    type,
    sequence_number: state.sequence++,
  });
}

/** Direct SSE string formatting for the legacy code paths that emit string[]. */
export function responsesEventToSse(event: ResponsesEvent): string {
  const type = asString(event["type"]);
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function responsesEventsToSse(events: ResponsesEvent[]): string[] {
  return events.map(responsesEventToSse);
}

function ensureStarted(state: ResponsesStreamState, out: ResponsesEvent[]): void {
  if (state.started) return;
  state.started = true;
  const response = {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status: "in_progress",
    model: state.model,
    output: [],
    error: null,
  };
  pushEvent(state, "response.created", { response }, out);
  pushEvent(state, "response.in_progress", { response }, out);
}

function ensureTextItem(state: ResponsesStreamState, out: ResponsesEvent[]): void {
  if (state.textStarted) return;
  state.textStarted = true;
  const item = {
    type: "message",
    id: state.textItemId,
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  pushEvent(state, "response.output_item.added", {
    output_index: state.outputIndex,
    item,
  }, out);
  pushEvent(state, "response.content_part.added", {
    item_id: state.textItemId,
    output_index: state.outputIndex,
    content_index: state.textContentIndex,
    part: { type: "output_text", text: "", annotations: [] },
  }, out);
}

function emitTextDelta(
  state: ResponsesStreamState,
  delta: string,
  out: ResponsesEvent[],
): void {
  if (delta.length === 0) return;
  ensureStarted(state, out);
  ensureTextItem(state, out);
  state.text += delta;
  pushEvent(state, "response.output_text.delta", {
    item_id: state.textItemId,
    output_index: state.outputIndex,
    content_index: state.textContentIndex,
    delta,
  }, out);
}

function emitToolCallDelta(
  state: ResponsesStreamState,
  index: number,
  piece: Record<string, unknown>,
  out: ResponsesEvent[],
): void {
  ensureStarted(state, out);
  let entry = state.toolCalls.get(index);
  if (entry === undefined) {
    const callId = asString(piece["id"] || newId("call"));
    const fn = isObject(piece["function"]) ? piece["function"] : {};
    entry = {
      itemId: newId("fc"),
      callId,
      name: asString(fn["name"]),
      arguments: asString(fn["arguments"] ?? ""),
      started: false,
    };
    state.toolCalls.set(index, entry);
  } else {
    if (typeof piece["id"] === "string" && piece["id"].length > 0) {
      entry.callId = piece["id"];
    }
    const fn = isObject(piece["function"]) ? piece["function"] : {};
    if (typeof fn["name"] === "string" && fn["name"].length > 0) {
      entry.name = fn["name"];
    }
    if (typeof fn["arguments"] === "string") {
      entry.arguments += fn["arguments"];
    }
  }

  if (!entry.started) {
    entry.started = true;
    const outputIndex = state.textStarted
      ? state.outputIndex + 1 + index
      : state.outputIndex + index;
    pushEvent(state, "response.output_item.added", {
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: entry.itemId,
        call_id: entry.callId,
        name: entry.name,
        arguments: "",
        status: "in_progress",
      },
    }, out);
  }

  const fn = isObject(piece["function"]) ? piece["function"] : {};
  const argsDelta = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
  if (argsDelta.length > 0) {
    const outputIndex = state.textStarted
      ? state.outputIndex + 1 + index
      : state.outputIndex + index;
    pushEvent(state, "response.function_call_arguments.delta", {
      item_id: entry.itemId,
      output_index: outputIndex,
      delta: argsDelta,
    }, out);
  }
}

function parseSseDataLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Convert one OpenAI chat-completions SSE frame (or multi-line chunk)
 * into zero or more Responses SSE events.
 */
export function chatStreamChunkToResponsesEvents(
  chunk: string,
  state: ResponsesStreamState,
): string[] {
  const out: ResponsesEvent[] = [];
  state.sseBuffer += chunk;
  const lines = state.sseBuffer.split(/\r?\n/);
  state.sseBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) continue;
    if (trimmed === "data: [DONE]") continue;

    const parsed = parseSseDataLine(trimmed);
    if (!isObject(parsed)) continue;

    // Upstream error payloads
    if (isObject(parsed["error"])) {
      ensureStarted(state, out);
      pushEvent(state, "error", { error: parsed["error"] }, out);
      continue;
    }

    if (typeof parsed["model"] === "string" && parsed["model"].length > 0) {
      state.model = parsed["model"];
    }
    if (isObject(parsed["usage"])) {
      state.usage = parsed["usage"];
    }

    const choices = Array.isArray(parsed["choices"]) ? parsed["choices"] : [];
    const choice = isObject(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) {
      ensureStarted(state, out);
      continue;
    }

    if (typeof choice["finish_reason"] === "string") {
      state.finishReason = choice["finish_reason"];
    }

    const delta = isObject(choice["delta"]) ? choice["delta"] : {};
    if (typeof delta["content"] === "string") {
      emitTextDelta(state, delta["content"], out);
    }
    if (typeof delta["reasoning_content"] === "string") {
      // Surface reasoning as plain text delta when present (best-effort).
      emitTextDelta(state, delta["reasoning_content"], out);
    }
    if (Array.isArray(delta["tool_calls"])) {
      for (const tc of delta["tool_calls"]) {
        if (!isObject(tc)) continue;
        const index = typeof tc["index"] === "number" ? tc["index"] : 0;
        emitToolCallDelta(state, index, tc, out);
      }
    }
  }
  return responsesEventsToSse(out);
}

/** Convert Anthropic Messages SSE frames into Responses SSE events. */
export function anthropicStreamChunkToResponsesEvents(
  chunk: string,
  state: ResponsesStreamState,
): string[] {
  const out: ResponsesEvent[] = [];
  state.sseBuffer += chunk;
  const lines = state.sseBuffer.split(/\r?\n/);
  state.sseBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const type = asString(parsed["type"]);
    if (type === "message_start") {
      const message = isObject(parsed["message"]) ? parsed["message"] : {};
      if (typeof message["model"] === "string") state.model = message["model"];
      ensureStarted(state, out);
      continue;
    }
    if (type === "content_block_delta") {
      const delta = isObject(parsed["delta"]) ? parsed["delta"] : {};
      if (typeof delta["text"] === "string") emitTextDelta(state, delta["text"], out);
      continue;
    }
    if (type === "message_delta") {
      const delta = isObject(parsed["delta"]) ? parsed["delta"] : {};
      const stopReason = delta["stop_reason"];
      if (typeof stopReason === "string") {
        state.finishReason = stopReason === "max_tokens" ? "length" :
          stopReason === "tool_use" ? "tool_calls" : "stop";
      }
      const usage = isObject(parsed["usage"]) ? parsed["usage"] : undefined;
      if (usage !== undefined) {
        state.usage = {
          prompt_tokens: usage["input_tokens"],
          completion_tokens: usage["output_tokens"],
          total_tokens:
            typeof usage["input_tokens"] === "number" && typeof usage["output_tokens"] === "number"
              ? (usage["input_tokens"] as number) + (usage["output_tokens"] as number)
              : undefined,
        };
      }
      continue;
    }
    if (type === "error") {
      ensureStarted(state, out);
      pushEvent(state, "error", { error: parsed["error"] ?? parsed }, out);
    }
  }
  return responsesEventsToSse(out);
}

export function finalizeResponsesStream(state: ResponsesStreamState): string[] {
  const out: ResponsesEvent[] = [];
  ensureStarted(state, out);

  if (state.textStarted) {
    pushEvent(state, "response.output_text.done", {
      item_id: state.textItemId,
      output_index: state.outputIndex,
      content_index: state.textContentIndex,
      text: state.text,
    }, out);
    pushEvent(state, "response.content_part.done", {
      item_id: state.textItemId,
      output_index: state.outputIndex,
      content_index: state.textContentIndex,
      part: { type: "output_text", text: state.text, annotations: [] },
    }, out);
    pushEvent(state, "response.output_item.done", {
      output_index: state.outputIndex,
      item: {
        type: "message",
        id: state.textItemId,
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: state.text, annotations: [] },
        ],
      },
    }, out);
  }

  const toolEntries = [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [index, entry] of toolEntries) {
    const outputIndex = state.textStarted
      ? state.outputIndex + 1 + index
      : state.outputIndex + index;
    pushEvent(state, "response.function_call_arguments.done", {
      item_id: entry.itemId,
      output_index: outputIndex,
      arguments: entry.arguments,
    }, out);
    pushEvent(state, "response.output_item.done", {
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: entry.itemId,
        call_id: entry.callId,
        name: entry.name,
        arguments: entry.arguments,
        status: "completed",
      },
    }, out);
  }

  const status = finishReasonToStatus(state.finishReason);
  const inputTokens =
    typeof state.usage?.["prompt_tokens"] === "number"
      ? state.usage["prompt_tokens"]
      : 0;
  const outputTokens =
    typeof state.usage?.["completion_tokens"] === "number"
      ? state.usage["completion_tokens"]
      : Math.ceil(state.text.length / 4);
  const totalTokens =
    typeof state.usage?.["total_tokens"] === "number"
      ? state.usage["total_tokens"]
      : inputTokens + outputTokens;

  const output: Array<Record<string, unknown>> = [];
  if (state.textStarted || toolEntries.length === 0) {
    output.push({
      type: "message",
      id: state.textItemId,
      status: status === "incomplete" ? "incomplete" : "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.text, annotations: [] }],
    });
  }
  for (const [, entry] of toolEntries) {
    output.push({
      type: "function_call",
      id: entry.itemId,
      call_id: entry.callId,
      name: entry.name,
      arguments: entry.arguments,
      status: "completed",
    });
  }

  const response = {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    error: null,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: state.model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
    output_text: state.text,
  };

  pushEvent(state, "response.completed", { response }, out);
  return responsesEventsToSse(out);
}

export function extractResponsesOutputText(
  response: Record<string, unknown>,
): string {
  if (typeof response["output_text"] === "string") {
    return response["output_text"];
  }
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isObject(item)) continue;
    if (item["type"] === "message") {
      parts.push(extractTextFromContent(item["content"]));
    }
  }
  return parts.join("");
}
