/**
 * OpenAI <-> Anthropic format converters.
 *
 * Direct port of `app/core/format_converters.py`. Every edge case (tool call
 * ordering, missing ids, raw argument strings, collapsed content arrays) is
 * preserved 1:1 so we can share the existing test vectors.
 */

const TEXT_BLOCK = "text" as const;
const TOOL_USE_BLOCK = "tool_use" as const;
const TOOL_RESULT_BLOCK = "tool_result" as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonDumpsCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

export function parseArguments(args: unknown): Record<string, unknown> {
  if (isObject(args)) return args;
  if (args === undefined || args === null || args === "") return {};
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isObject(parsed)) return parsed;
    } catch {
      // fall through
    }
    return { _raw: args };
  }
  return { value: args };
}

function openaiTextBlocks(content: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (content === undefined || content === null) return out;
  if (typeof content === "string") {
    if (content.length > 0) out.push({ type: TEXT_BLOCK, text: content });
    return out;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isObject(part)) {
        if (part["type"] === TEXT_BLOCK) {
          out.push({ type: TEXT_BLOCK, text: String(part["text"] ?? "") });
        } else {
          out.push({ type: TEXT_BLOCK, text: jsonDumpsCompact(part) });
        }
      } else if (typeof part === "string") {
        out.push({ type: TEXT_BLOCK, text: part });
      } else if (part !== undefined && part !== null) {
        out.push({ type: TEXT_BLOCK, text: String(part) });
      }
    }
    return out;
  }
  out.push({ type: TEXT_BLOCK, text: String(content) });
  return out;
}

function collapseBlocks(
  blocks: Array<Record<string, unknown>>,
): string | Array<Record<string, unknown>> {
  if (blocks.length === 0) return "";
  if (blocks.every((b) => b["type"] === TEXT_BLOCK)) {
    return blocks.map((b) => String(b["text"] ?? "")).join("");
  }
  return blocks;
}

function normalizeToolResultContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const normalized: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (isObject(part) && part["type"] === TEXT_BLOCK) {
        normalized.push({ type: TEXT_BLOCK, text: String(part["text"] ?? "") });
      } else if (typeof part === "string") {
        normalized.push({ type: TEXT_BLOCK, text: part });
      } else if (part !== undefined && part !== null) {
        normalized.push({ type: TEXT_BLOCK, text: String(part) });
      }
    }
    return normalized.length > 0 ? normalized : "";
  }
  return content ?? "";
}

function* iterAnthropicBlocks(content: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isObject(block)) yield block;
    }
  } else if (isObject(content)) {
    yield content;
  } else if (content !== undefined && content !== null && content !== "") {
    yield { type: TEXT_BLOCK, text: String(content) };
  }
}

function anthropicBlockToText(block: Record<string, unknown>): string {
  const btype = block["type"];
  if (btype === TEXT_BLOCK) return String(block["text"] ?? "");
  if (btype === TOOL_RESULT_BLOCK) {
    const inner = block["content"];
    if (Array.isArray(inner)) {
      return inner
        .filter(isObject)
        .map((sub) => anthropicBlockToText(sub))
        .join("");
    }
    if (typeof inner === "string") return inner;
    return String(inner ?? "");
  }
  if (btype === TOOL_USE_BLOCK) {
    const name = String(block["name"] ?? "tool");
    return `[tool_use:${name}]`;
  }
  return jsonDumpsCompact(block);
}

function splitAnthropicUserContent(content: unknown): {
  text: string | undefined;
  toolMessages: Array<Record<string, unknown>>;
} {
  const textChunks: string[] = [];
  const toolMessages: Array<Record<string, unknown>> = [];
  for (const block of iterAnthropicBlocks(content)) {
    const btype = block["type"];
    if (btype === TEXT_BLOCK) {
      textChunks.push(String(block["text"] ?? ""));
    } else if (btype === TOOL_RESULT_BLOCK) {
      const inner = block["content"];
      const textual = typeof inner === "string" ? inner : anthropicBlockToText(block);
      toolMessages.push({
        role: "tool",
        tool_call_id: block["tool_use_id"],
        content: textual,
      });
    } else {
      textChunks.push(anthropicBlockToText(block));
    }
  }
  const text = textChunks.filter((s) => s.length > 0).join("\n");
  return { text: text.length > 0 ? text : undefined, toolMessages };
}

function splitAnthropicAssistantContent(content: unknown): {
  text: string | undefined;
  toolCalls: Array<Record<string, unknown>>;
} {
  const textChunks: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of iterAnthropicBlocks(content)) {
    const btype = block["type"];
    if (btype === TEXT_BLOCK) {
      textChunks.push(String(block["text"] ?? ""));
    } else if (btype === TOOL_USE_BLOCK) {
      const argsStr = jsonDumpsCompact(block["input"] ?? {});
      toolCalls.push({
        id: block["id"] ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: block["name"],
          arguments: argsStr,
        },
      });
    } else if (btype === TOOL_RESULT_BLOCK) {
      textChunks.push(anthropicBlockToText(block));
    } else {
      textChunks.push(anthropicBlockToText(block));
    }
  }
  const text = textChunks.filter((s) => s.length > 0).join("\n");
  return { text: text.length > 0 ? text : undefined, toolCalls };
}

export function anthropicToOpenaiRequest(
  anthropicRequest: Record<string, unknown>,
): Record<string, unknown> {
  const openaiMessages: Array<Record<string, unknown>> = [];
  const system = anthropicRequest["system"];

  if (system !== undefined && system !== null && system !== "") {
    let systemText = "";
    if (typeof system === "string") {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system
        .filter(isObject)
        .map((block) => anthropicBlockToText(block))
        .join("\n");
    }
    if (systemText.length > 0) {
      openaiMessages.push({ role: "system", content: systemText });
    }
  }

  const messages = Array.isArray(anthropicRequest["messages"])
    ? (anthropicRequest["messages"] as unknown[])
    : [];

  for (const rawMsg of messages) {
    if (!isObject(rawMsg)) continue;
    const role = rawMsg["role"];
    const content = rawMsg["content"];

    if (role === "assistant") {
      const { text, toolCalls } = splitAnthropicAssistantContent(content);
      const out: Record<string, unknown> = {
        role: "assistant",
        content: text ?? null,
      };
      if (toolCalls.length > 0) out["tool_calls"] = toolCalls;
      openaiMessages.push(out);
    } else if (role === "user") {
      const { text, toolMessages } = splitAnthropicUserContent(content);
      // Tool outputs MUST come immediately after the assistant tool_calls turn.
      for (const tm of toolMessages) openaiMessages.push(tm);
      if (text !== undefined) {
        openaiMessages.push({ role: "user", content: text });
      }
    } else {
      openaiMessages.push({
        role,
        content: anthropicBlockToText({ type: TEXT_BLOCK, text: content }),
      });
    }
  }

  const openaiRequest: Record<string, unknown> = {
    model: anthropicRequest["model"],
    messages: openaiMessages,
    max_tokens: anthropicRequest["max_tokens"],
  };

  if ("temperature" in anthropicRequest) openaiRequest["temperature"] = anthropicRequest["temperature"];
  if ("top_p" in anthropicRequest) openaiRequest["top_p"] = anthropicRequest["top_p"];
  if ("stream" in anthropicRequest) openaiRequest["stream"] = anthropicRequest["stream"];

  const anthropicTools = anthropicRequest["tools"];
  if (Array.isArray(anthropicTools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of anthropicTools) {
      if (!isObject(tool)) continue;
      tools.push({
        type: "function",
        function: {
          name: tool["name"],
          description: tool["description"],
          parameters: tool["input_schema"] ?? {},
        },
      });
    }
    openaiRequest["tools"] = tools;
  }

  const toolChoice = anthropicRequest["tool_choice"];
  if (isObject(toolChoice) && toolChoice["type"] === "tool") {
    openaiRequest["tool_choice"] = {
      type: "function",
      function: { name: toolChoice["name"] },
    };
  } else if (toolChoice !== undefined) {
    openaiRequest["tool_choice"] = toolChoice;
  }

  const stops = anthropicRequest["stop_sequences"];
  if (Array.isArray(stops) && stops.length > 0) {
    openaiRequest["stop"] = stops.length === 1 ? stops[0] : stops;
  }

  return openaiRequest;
}

export function openaiToAnthropicRequest(
  openaiRequest: Record<string, unknown>,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const systemSegments: string[] = [];

  const raw = Array.isArray(openaiRequest["messages"])
    ? (openaiRequest["messages"] as unknown[])
    : [];

  for (const rawMsg of raw) {
    if (!isObject(rawMsg)) continue;
    const role = rawMsg["role"];
    const content = rawMsg["content"];

    if (role === "system") {
      if (Array.isArray(content)) {
        const joined = content
          .filter(isObject)
          .map((part) => String(part["text"] ?? ""))
          .join("");
        if (joined.length > 0) systemSegments.push(joined);
      } else if (typeof content === "string" && content.length > 0) {
        systemSegments.push(content);
      }
      continue;
    }

    if (role === "tool") {
      const metadata = rawMsg["metadata"];
      const isError =
        isObject(metadata) && "is_error" in metadata ? metadata["is_error"] : null;
      const block: Record<string, unknown> = {
        type: TOOL_RESULT_BLOCK,
        tool_use_id: rawMsg["tool_call_id"],
        content: normalizeToolResultContent(content),
        is_error: isError,
      };
      messages.push({ role: "user", content: [block] });
      continue;
    }

    const targetRole = role === "assistant" || role === "user" ? role : "user";
    const blocks = openaiTextBlocks(content);

    if (role === "assistant" && Array.isArray(rawMsg["tool_calls"])) {
      for (const call of rawMsg["tool_calls"] as unknown[]) {
        if (!isObject(call)) continue;
        const fn = (call["function"] as Record<string, unknown>) ?? {};
        const parsed = parseArguments(fn["arguments"]);
        blocks.push({
          type: TOOL_USE_BLOCK,
          id: call["id"],
          name: fn["name"],
          input: parsed,
        });
      }
    }

    const normalized = collapseBlocks(blocks);
    messages.push({ role: targetRole, content: normalized });
  }

  const out: Record<string, unknown> = {
    model: openaiRequest["model"],
    messages,
    max_tokens: openaiRequest["max_tokens"] ?? 1024,
  };

  if (systemSegments.length > 0) {
    out["system"] = systemSegments.join("\n\n");
  }
  if ("temperature" in openaiRequest) out["temperature"] = openaiRequest["temperature"];
  if ("top_p" in openaiRequest) out["top_p"] = openaiRequest["top_p"];
  if ("stream" in openaiRequest) out["stream"] = openaiRequest["stream"];

  const stop = openaiRequest["stop"];
  if (Array.isArray(stop)) out["stop_sequences"] = stop;
  else if (typeof stop === "string") out["stop_sequences"] = [stop];

  const openaiTools = openaiRequest["tools"];
  if (Array.isArray(openaiTools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of openaiTools) {
      if (!isObject(tool)) continue;
      if (tool["type"] === "function") {
        const fn = (tool["function"] as Record<string, unknown>) ?? {};
        tools.push({
          name: fn["name"],
          description: fn["description"] ?? "",
          input_schema: fn["parameters"] ?? {},
        });
      }
    }
    out["tools"] = tools;
  }

  const toolChoice = openaiRequest["tool_choice"];
  if (isObject(toolChoice) && toolChoice["type"] === "function") {
    const fn = (toolChoice["function"] as Record<string, unknown>) ?? {};
    out["tool_choice"] = { type: "tool", name: fn["name"] };
  } else if (toolChoice !== undefined && toolChoice !== null && toolChoice !== "") {
    out["tool_choice"] = toolChoice;
  }

  return out;
}

export function anthropicToOpenaiResponse(
  anthropicResponse: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const contentBlocks = Array.isArray(anthropicResponse["content"])
    ? (anthropicResponse["content"] as unknown[])
    : [];

  let textContent = "";
  let toolCalls: Array<Record<string, unknown>> | undefined = undefined;

  for (const block of contentBlocks) {
    if (!isObject(block)) continue;
    const btype = block["type"];
    if (btype === TEXT_BLOCK) {
      textContent += String(block["text"] ?? "");
    } else if (btype === TOOL_USE_BLOCK) {
      toolCalls ??= [];
      toolCalls.push({
        id: block["id"],
        type: "function",
        function: {
          name: block["name"],
          arguments: jsonDumpsCompact(block["input"] ?? {}),
        },
      });
    } else if (btype === TOOL_RESULT_BLOCK) {
      textContent += anthropicBlockToText(block);
    }
  }

  const stopReason = anthropicResponse["stop_reason"];
  const finishReasonMap: Record<string, string> = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
    tool_use: "tool_calls",
  };
  const finishReason =
    toolCalls !== undefined && toolCalls.length > 0
      ? "tool_calls"
      : typeof stopReason === "string"
        ? (finishReasonMap[stopReason] ?? "stop")
        : "stop";

  const usage = isObject(anthropicResponse["usage"]) ? anthropicResponse["usage"] : {};
  const inputTokens = Number(usage["input_tokens"] ?? 0);
  const outputTokens = Number(usage["output_tokens"] ?? 0);

  const messageContent = toolCalls !== undefined ? null : textContent;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: messageContent,
  };
  if (toolCalls !== undefined) message["tool_calls"] = toolCalls;

  return {
    id:
      typeof anthropicResponse["id"] === "string"
        ? anthropicResponse["id"]
        : `chatcmpl-${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export function openaiToAnthropicResponse(
  openaiResponse: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = Array.isArray(openaiResponse["choices"])
    ? (openaiResponse["choices"] as unknown[])
    : [];
  const choice = isObject(choices[0]) ? (choices[0] as Record<string, unknown>) : {};
  const message = isObject(choice["message"])
    ? (choice["message"] as Record<string, unknown>)
    : {};

  const contentBlocks: Array<Record<string, unknown>> = [];
  const msgContent = message["content"];
  if (typeof msgContent === "string" && msgContent.length > 0) {
    contentBlocks.push({ type: TEXT_BLOCK, text: msgContent });
  } else if (Array.isArray(msgContent)) {
    for (const part of msgContent) {
      if (isObject(part) && part["type"] === TEXT_BLOCK) {
        contentBlocks.push({ type: TEXT_BLOCK, text: String(part["text"] ?? "") });
      } else if (typeof part === "string") {
        contentBlocks.push({ type: TEXT_BLOCK, text: part });
      }
    }
  }

  const toolCalls = Array.isArray(message["tool_calls"])
    ? (message["tool_calls"] as unknown[])
    : [];
  for (const call of toolCalls) {
    if (!isObject(call)) continue;
    const fn = (call["function"] as Record<string, unknown>) ?? {};
    const input = parseArguments(fn["arguments"]);
    contentBlocks.push({
      type: TOOL_USE_BLOCK,
      id: call["id"],
      name: fn["name"],
      input,
    });
  }

  const finishReason = choice["finish_reason"];
  const stopReasonMap: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
  };
  const stopReason =
    typeof finishReason === "string"
      ? (stopReasonMap[finishReason] ?? "end_turn")
      : "end_turn";

  const usage = isObject(openaiResponse["usage"]) ? openaiResponse["usage"] : {};
  const inputTokens = Number(usage["prompt_tokens"] ?? 0);
  const outputTokens = Number(usage["completion_tokens"] ?? 0);

  return {
    id:
      typeof openaiResponse["id"] === "string"
        ? openaiResponse["id"]
        : `msg-${Math.floor(Date.now() / 1000)}`,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
