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

interface ResponsesToolIdentity {
  name: string;
  namespace?: string;
}

interface ConvertedResponsesTools {
  tools: Record<string, unknown>[];
  identities: Map<string, ResponsesToolIdentity>;
}

const CHAT_TOOL_NAME_MAX_LENGTH = 64;

function toolNameHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function namespacedChatToolName(namespace: string, name: string): string {
  const natural = namespace.endsWith("_") || name.startsWith("_")
    ? `${namespace}${name}`
    : `${namespace}__${name}`;
  if (natural.length <= CHAT_TOOL_NAME_MAX_LENGTH) return natural;
  const suffix = `_${toolNameHash(`${namespace}\0${name}`)}`;
  return `${natural.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function responseFunctionToChat(
  tool: Record<string, unknown>,
  name: string,
  namespaceDescription?: unknown,
): Record<string, unknown> {
  const fn: Record<string, unknown> = { name };
  const childDescription = tool["description"];
  if (typeof namespaceDescription === "string" && namespaceDescription.length > 0) {
    fn["description"] = typeof childDescription === "string" && childDescription.length > 0
      ? `${namespaceDescription}\n\n${childDescription}`
      : namespaceDescription;
  } else if (childDescription !== undefined) {
    fn["description"] = childDescription;
  }
  if (tool["parameters"] !== undefined) fn["parameters"] = tool["parameters"];
  if (tool["strict"] !== undefined) fn["strict"] = tool["strict"];
  return { type: "function", function: fn };
}

/** Convert Responses tools without silently dropping declarations. */
function convertResponsesTools(tools: unknown): ConvertedResponsesTools {
  const converted: Record<string, unknown>[] = [];
  const identities = new Map<string, ResponsesToolIdentity>();
  if (!Array.isArray(tools)) return { tools: converted, identities };

  for (const rawTool of tools) {
    if (!isObject(rawTool)) continue;
    const type = asString(rawTool["type"] || "function");
    if (type === "function") {
      if (isObject(rawTool["function"])) {
        const fn = rawTool["function"];
        const name = asString(fn["name"]);
        if (name.length > 0) identities.set(name, { name });
        converted.push({ type: "function", function: fn });
      } else {
        const name = asString(rawTool["name"]);
        if (name.length === 0) continue;
        identities.set(name, { name });
        converted.push(responseFunctionToChat(rawTool, name));
      }
      continue;
    }

    if (type === "namespace") {
      const namespace = asString(rawTool["name"]);
      const children = Array.isArray(rawTool["tools"]) ? rawTool["tools"] : [];
      for (const rawChild of children) {
        if (!isObject(rawChild) || asString(rawChild["type"] || "function") !== "function") continue;
        const childName = asString(rawChild["name"]);
        if (namespace.length === 0 || childName.length === 0) continue;
        const chatName = namespacedChatToolName(namespace, childName);
        const existing = identities.get(chatName);
        if (existing !== undefined &&
          (existing.name !== childName || existing.namespace !== namespace)) {
          throw new Error(`Responses tools cannot be represented without a name collision: ${chatName}`);
        }
        identities.set(chatName, { namespace, name: childName });
        converted.push(responseFunctionToChat(rawChild, chatName, rawTool["description"]));
      }
      continue;
    }

    // There is no generic Chat representation for provider-hosted built-ins.
    // Keep them intact and let the configured upstream accept or reject them.
    converted.push(rawTool);
  }
  return { tools: converted, identities };
}

function toolIdentityForChatName(
  name: string,
  identities: Map<string, ResponsesToolIdentity>,
): ResponsesToolIdentity {
  return identities.get(name) ?? { name };
}

function responseCallNameToChat(
  item: Record<string, unknown>,
  identities: Map<string, ResponsesToolIdentity>,
): string {
  const namespace = asString(item["namespace"]);
  const name = asString(item["name"]);
  if (namespace.length === 0) return name;
  for (const [chatName, identity] of identities) {
    if (identity.namespace === namespace && identity.name === name) return chatName;
  }
  return namespacedChatToolName(namespace, name);
}

function appendInputItem(
  messages: Array<Record<string, unknown>>,
  item: unknown,
  toolIdentities: Map<string, ResponsesToolIdentity>,
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
    const name = responseCallNameToChat(item, toolIdentities);
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
  const convertedTools = convertResponsesTools(request["tools"]);

  const instructions = request["instructions"];
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  const input = request["input"];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendInputItem(messages, item, convertedTools.identities);
  } else if (isObject(input)) {
    appendInputItem(messages, input, convertedTools.identities);
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
    "prompt_cache_key",
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

  if (convertedTools.tools.length > 0) chat["tools"] = convertedTools.tools;

  const toolChoice = request["tool_choice"];
  if (isObject(toolChoice) && toolChoice["type"] === "function") {
    const chatName = responseCallNameToChat(toolChoice, convertedTools.identities);
    chat["tool_choice"] = { type: "function", function: { name: chatName } };
  }

  return chat;
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
    requestTools?: unknown[];
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
      summary: [],
      content: [{ type: "reasoning_text", text: reasoning }],
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
    const toolIdentities = convertResponsesTools(options.requestTools).identities;
    for (const raw of message["tool_calls"]) {
      if (!isObject(raw)) continue;
      const fn = isObject(raw["function"]) ? raw["function"] : {};
      const callId = asString(raw["id"] || newId("call"));
      const identity = toolIdentityForChatName(asString(fn["name"]), toolIdentities);
      const call: Record<string, unknown> = {
        type: "function_call",
        id: newId("fc"),
        call_id: callId,
        name: identity.name,
        arguments: asString(fn["arguments"] ?? ""),
        status: "completed",
      };
      if (identity.namespace !== undefined) call["namespace"] = identity.namespace;
      output.push(call);
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
  reasoningItemId: string;
  textContentIndex: number;
  outputIndex: number;
  started: boolean;
  textStarted: boolean;
  reasoningStarted: boolean;
  text: string;
  reasoningText: string;
  toolCalls: Map<
    number,
    {
      itemId: string;
      callId: string;
      name: string;
      namespace?: string;
      arguments: string;
      started: boolean;
    }
  >;
  toolIdentities: Map<string, ResponsesToolIdentity>;
  usage: Record<string, unknown> | undefined;
  finishReason: string | null;
  sequence: number;
  /** Partial upstream SSE data retained across fetch reads. */
  sseBuffer: string;
}

export function createResponsesStreamState(
  model: string,
  responseId?: string,
  requestTools?: unknown[],
): ResponsesStreamState {
  return {
    responseId: responseId ?? newId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    textItemId: newId("msg"),
    reasoningItemId: newId("rsn"),
    textContentIndex: 0,
    outputIndex: 0,
    started: false,
    textStarted: false,
    reasoningStarted: false,
    text: "",
    reasoningText: "",
    toolCalls: new Map(),
    toolIdentities: convertResponsesTools(requestTools).identities,
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
    .map(([, entry]) => {
      let chatName = entry.name;
      if (entry.namespace !== undefined) {
        for (const [candidate, identity] of state.toolIdentities) {
          if (identity.namespace === entry.namespace && identity.name === entry.name) {
            chatName = candidate;
            break;
          }
        }
      }
      return {
        id: entry.callId,
        type: "function",
        function: { name: chatName, arguments: entry.arguments },
      };
    });
  const message: Record<string, unknown> = {
    role: "assistant",
    content: state.text || null,
  };
  if (state.reasoningText.length > 0) message["reasoning_content"] = state.reasoningText;
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
    output_index: state.outputIndex + (state.reasoningStarted ? 1 : 0),
    item,
  }, out);
  pushEvent(state, "response.content_part.added", {
    item_id: state.textItemId,
    output_index: state.outputIndex + (state.reasoningStarted ? 1 : 0),
    content_index: state.textContentIndex,
    part: { type: "output_text", text: "", annotations: [] },
  }, out);
}

function emitReasoningDelta(
  state: ResponsesStreamState,
  delta: string,
  out: ResponsesEvent[],
): void {
  if (delta.length === 0) return;
  ensureStarted(state, out);
  if (!state.reasoningStarted) {
    state.reasoningStarted = true;
    pushEvent(state, "response.output_item.added", {
      output_index: state.outputIndex,
      item: {
        type: "reasoning",
        id: state.reasoningItemId,
        status: "in_progress",
        summary: [],
        content: [],
      },
    }, out);
  }
  state.reasoningText += delta;
  pushEvent(state, "response.reasoning_text.delta", {
    item_id: state.reasoningItemId,
    output_index: state.outputIndex,
    content_index: 0,
    delta,
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
    output_index: state.outputIndex + (state.reasoningStarted ? 1 : 0),
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
    const identity = toolIdentityForChatName(asString(fn["name"]), state.toolIdentities);
    entry = {
      itemId: newId("fc"),
      callId,
      name: identity.name,
      ...(identity.namespace !== undefined ? { namespace: identity.namespace } : {}),
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
      const identity = toolIdentityForChatName(fn["name"], state.toolIdentities);
      entry.name = identity.name;
      if (identity.namespace !== undefined) entry.namespace = identity.namespace;
    }
    if (typeof fn["arguments"] === "string") {
      entry.arguments += fn["arguments"];
    }
  }

  if (!entry.started) {
    entry.started = true;
    const outputIndex = state.outputIndex +
      (state.reasoningStarted ? 1 : 0) +
      (state.textStarted ? 1 : 0) + index;
    pushEvent(state, "response.output_item.added", {
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: entry.itemId,
        call_id: entry.callId,
        ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
        name: entry.name,
        arguments: "",
        status: "in_progress",
      },
    }, out);
  }

  const fn = isObject(piece["function"]) ? piece["function"] : {};
  const argsDelta = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
  if (argsDelta.length > 0) {
    const outputIndex = state.outputIndex +
      (state.reasoningStarted ? 1 : 0) +
      (state.textStarted ? 1 : 0) + index;
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
      emitReasoningDelta(state, delta["reasoning_content"], out);
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

/**
 * Merge one Anthropic usage payload (message_start or message_delta) into the
 * accumulated chat-shaped usage. Anthropic `input_tokens` excludes cache
 * reads/writes, while OpenAI `prompt_tokens` includes them, so cached tokens
 * are folded back in and surfaced via `prompt_tokens_details.cached_tokens`.
 */
function mergeAnthropicUsageIntoChatUsage(
  usage: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const prev = previous ?? {};
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const prevDetails = isObject(prev["prompt_tokens_details"])
    ? prev["prompt_tokens_details"]
    : undefined;

  const cacheRead =
    num(usage["cache_read_input_tokens"]) ?? num(prevDetails?.["cached_tokens"]);
  const cacheCreation =
    num(usage["cache_creation_input_tokens"]) ?? num(prev["cache_creation_input_tokens"]);
  const inputTokens = num(usage["input_tokens"]);
  const promptTokens =
    inputTokens !== undefined
      ? inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0)
      : num(prev["prompt_tokens"]);
  const completionTokens = num(usage["output_tokens"]) ?? num(prev["completion_tokens"]);

  const merged: Record<string, unknown> = { ...prev };
  if (promptTokens !== undefined) merged["prompt_tokens"] = promptTokens;
  if (completionTokens !== undefined) merged["completion_tokens"] = completionTokens;
  if (promptTokens !== undefined || completionTokens !== undefined) {
    merged["total_tokens"] = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  if (cacheRead !== undefined) {
    merged["prompt_tokens_details"] = { cached_tokens: cacheRead };
  }
  if (cacheCreation !== undefined) {
    merged["cache_creation_input_tokens"] = cacheCreation;
  }
  return merged;
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
      // Anthropic reports input/cache token counts on message_start.
      const startUsage = isObject(message["usage"]) ? message["usage"] : undefined;
      if (startUsage !== undefined) {
        state.usage = mergeAnthropicUsageIntoChatUsage(startUsage, state.usage);
      }
      ensureStarted(state, out);
      continue;
    }
    if (type === "content_block_start") {
      const block = isObject(parsed["content_block"]) ? parsed["content_block"] : {};
      if (block["type"] === "tool_use") {
        const index = typeof parsed["index"] === "number" ? parsed["index"] : 0;
        emitToolCallDelta(state, index, {
          id: block["id"],
          function: { name: block["name"], arguments: "" },
        }, out);
      }
      continue;
    }
    if (type === "content_block_delta") {
      const delta = isObject(parsed["delta"]) ? parsed["delta"] : {};
      if (typeof delta["text"] === "string") emitTextDelta(state, delta["text"], out);
      if (typeof delta["thinking"] === "string") emitReasoningDelta(state, delta["thinking"], out);
      if (typeof delta["partial_json"] === "string") {
        const index = typeof parsed["index"] === "number" ? parsed["index"] : 0;
        emitToolCallDelta(state, index, {
          function: { arguments: delta["partial_json"] },
        }, out);
      }
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
        state.usage = mergeAnthropicUsageIntoChatUsage(usage, state.usage);
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

  if (state.reasoningStarted) {
    pushEvent(state, "response.output_item.done", {
      output_index: state.outputIndex,
      item: {
        type: "reasoning",
        id: state.reasoningItemId,
        status: "completed",
        summary: [],
        content: [{ type: "reasoning_text", text: state.reasoningText }],
      },
    }, out);
  }

  if (state.textStarted) {
    const textOutputIndex = state.outputIndex + (state.reasoningStarted ? 1 : 0);
    pushEvent(state, "response.output_text.done", {
      item_id: state.textItemId,
      output_index: textOutputIndex,
      content_index: state.textContentIndex,
      text: state.text,
    }, out);
    pushEvent(state, "response.content_part.done", {
      item_id: state.textItemId,
      output_index: textOutputIndex,
      content_index: state.textContentIndex,
      part: { type: "output_text", text: state.text, annotations: [] },
    }, out);
    pushEvent(state, "response.output_item.done", {
      output_index: textOutputIndex,
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
    const outputIndex = state.outputIndex +
      (state.reasoningStarted ? 1 : 0) +
      (state.textStarted ? 1 : 0) + index;
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
        ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
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
  const promptDetails = isObject(state.usage?.["prompt_tokens_details"])
    ? state.usage["prompt_tokens_details"]
    : undefined;
  const cachedTokens =
    typeof promptDetails?.["cached_tokens"] === "number"
      ? promptDetails["cached_tokens"]
      : undefined;

  const output: Array<Record<string, unknown>> = [];
  if (state.reasoningStarted) {
    output.push({
      type: "reasoning",
      id: state.reasoningItemId,
      status: status === "incomplete" ? "incomplete" : "completed",
      summary: [],
      content: [{ type: "reasoning_text", text: state.reasoningText }],
    });
  }
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
      ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
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
      ...(cachedTokens !== undefined
        ? { input_tokens_details: { cached_tokens: cachedTokens } }
        : {}),
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
