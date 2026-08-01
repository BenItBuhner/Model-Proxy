import {
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
} from "../format/converters.ts";
import {
  anthropicStreamChunkToResponsesEvents,
  chatResponseToResponses,
  chatStreamChunkToResponsesEvents,
  createResponsesStreamState,
  finalizeResponsesStream,
  responsesRequestToChat,
} from "../format/responses.ts";
import { createLogger } from "../observability/logger.ts";
import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
  ResponsesCallArgs,
} from "../providers/base.ts";
import {
  ProviderAPIError,
  ProviderTimeoutError,
  RouteExecutionError,
} from "../providers/errors.ts";
import { providerRegistry } from "../providers/registry.ts";
import type { ResolvedRoute } from "../../shared/schemas/routing.ts";

const log = createLogger("routing.executor");

export interface ExecuteArgs {
  route: ResolvedRoute;
  requestData: Record<string, unknown>;
  targetProtocol: "openai" | "anthropic" | "responses";
  signal?: AbortSignal;
  validateResponse?: boolean;
}

function buildContext(
  route: ResolvedRoute,
  signal: AbortSignal | undefined,
): ProviderCallContext {
  const ctx: ProviderCallContext = {
    apiKey: route.apiKey,
    baseUrlOverride: route.baseUrl,
    timeoutSeconds: route.timeoutSeconds,
    signal,
  };
  if (route.egressProxyUrl !== undefined) ctx.egressProxyUrl = route.egressProxyUrl;
  if (route.extraHeaders !== undefined) ctx.extraHeaders = route.extraHeaders;
  if (route.bufferPartialToolCalls !== undefined) {
    ctx.bufferPartialToolCalls = route.bufferPartialToolCalls;
  }
  return ctx;
}

function openaiArgsFromRequest(
  request: Record<string, unknown>,
  model: string,
): OpenAICallArgs {
  return {
    model,
    messages: (request["messages"] as unknown[]) ?? [],
    temperature: request["temperature"] as number | undefined,
    top_p: request["top_p"] as number | undefined,
    n: request["n"] as number | undefined,
    stream: Boolean(request["stream"]),
    stop: request["stop"] as string | string[] | undefined,
    max_tokens: request["max_tokens"] as number | undefined,
    max_completion_tokens: request["max_completion_tokens"] as number | undefined,
    presence_penalty: request["presence_penalty"] as number | undefined,
    frequency_penalty: request["frequency_penalty"] as number | undefined,
    logit_bias: request["logit_bias"] as Record<string, number> | undefined,
    user: request["user"] as string | undefined,
    tools: request["tools"] as unknown[] | undefined,
    tool_choice: request["tool_choice"],
    response_format: request["response_format"],
    chat_template_kwargs: request["chat_template_kwargs"] as
      | Record<string, unknown>
      | undefined,
  };
}

function anthropicArgsFromRequest(
  request: Record<string, unknown>,
  model: string,
): AnthropicCallArgs {
  const maxTokens = request["max_tokens"];
  return {
    model,
    messages: (request["messages"] as unknown[]) ?? [],
    max_tokens:
      typeof maxTokens === "number" && Number.isFinite(maxTokens) ? maxTokens : 4096,
    system: request["system"],
    temperature: request["temperature"] as number | undefined,
    top_p: request["top_p"] as number | undefined,
    top_k: request["top_k"] as number | undefined,
    stream: Boolean(request["stream"]),
    stop_sequences: request["stop_sequences"] as string[] | undefined,
    tools: request["tools"] as unknown[] | undefined,
    tool_choice: request["tool_choice"],
  };
}

function convertRequest(
  request: Record<string, unknown>,
  from: "openai" | "anthropic" | "responses",
  to: "openai" | "anthropic" | "responses",
): Record<string, unknown> {
  if (from === to) return request;
  if (from === "anthropic" && to === "openai") return anthropicToOpenaiRequest(request);
  if (from === "openai" && to === "anthropic") return openaiToAnthropicRequest(request);
  if (from === "responses" && to === "openai") return responsesRequestToChat(request);
  if (from === "responses" && to === "anthropic") {
    return openaiToAnthropicRequest(responsesRequestToChat(request));
  }
  if (from === "openai" && to === "responses") return openaiToResponsesRequest(request);
  if (from === "anthropic" && to === "responses") {
    return openaiToResponsesRequest(anthropicToOpenaiRequest(request));
  }
  return request;
}

function openaiToResponsesRequest(request: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(request["messages"]) ? request["messages"] : [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;
    const role = m["role"];

    if (role === "system") {
      // Skip system messages - they become instructions
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m["tool_call_id"],
        output: m["content"],
      });
    } else if (role === "assistant" && Array.isArray(m["tool_calls"])) {
      for (const tc of m["tool_calls"] as Array<Record<string, unknown>>) {
        input.push({
          type: "function_call",
          id: tc["id"],
          call_id: tc["id"],
          name: (tc["function"] as Record<string, unknown>)?.["name"],
          arguments: (tc["function"] as Record<string, unknown>)?.["arguments"],
        });
      }
    } else {
      input.push({
        type: "message",
        role,
        content: m["content"],
      });
    }
  }

  const responses: Record<string, unknown> = {
    model: request["model"],
    input,
  };

  if (request["temperature"] !== undefined) responses["temperature"] = request["temperature"];
  if (request["top_p"] !== undefined) responses["top_p"] = request["top_p"];
  if (request["stream"] !== undefined) responses["stream"] = request["stream"];
  if (request["stop"] !== undefined) responses["stop"] = request["stop"];
  if (request["presence_penalty"] !== undefined) responses["presence_penalty"] = request["presence_penalty"];
  if (request["frequency_penalty"] !== undefined) responses["frequency_penalty"] = request["frequency_penalty"];
  if (request["user"] !== undefined) responses["user"] = request["user"];
  if (request["seed"] !== undefined) responses["seed"] = request["seed"];
  if (request["tool_choice"] !== undefined) responses["tool_choice"] = request["tool_choice"];
  if (request["parallel_tool_calls"] !== undefined) responses["parallel_tool_calls"] = request["parallel_tool_calls"];
  if (request["response_format"] !== undefined) responses["text"] = { format: request["response_format"] };

  const maxTokens = request["max_tokens"] ?? request["max_completion_tokens"];
  if (typeof maxTokens === "number") responses["max_output_tokens"] = maxTokens;

  if (Array.isArray(request["tools"])) {
    responses["tools"] = request["tools"];
  }

  return responses;
}

function applyRouteBodyExtensions(
  request: Record<string, unknown>,
  route: ResolvedRoute,
): Record<string, unknown> {
  if (route.wireProtocol !== "openai") {
    return request;
  }
  return {
    ...(route.openaiBodyDefaults ?? {}),
    ...request,
    ...(route.openaiBodyExtensions ?? {}),
  };
}

function convertResponse(
  response: Record<string, unknown>,
  from: "openai" | "anthropic" | "responses",
  to: "openai" | "anthropic" | "responses",
  modelName: string,
  requestData?: Record<string, unknown>,
): Record<string, unknown> {
  if (from === to) return response;
  if (from === "openai" && to === "anthropic") return openaiToAnthropicResponse(response, modelName);
  if (from === "anthropic" && to === "openai") return anthropicToOpenaiResponse(response, modelName);
  if (from === "openai" && to === "responses") {
    return chatResponseToResponses(response, {
      model: modelName,
      metadata: responseMetadata(requestData),
      parallelToolCalls: responseParallelToolCalls(requestData),
    });
  }
  if (from === "anthropic" && to === "responses") {
    return chatResponseToResponses(
      anthropicToOpenaiResponse(response, modelName),
      {
        model: modelName,
        metadata: responseMetadata(requestData),
        parallelToolCalls: responseParallelToolCalls(requestData),
      },
    );
  }
  if (from === "responses" && to === "openai") return responsesToOpenaiResponse(response, modelName);
  if (from === "responses" && to === "anthropic") return openaiToAnthropicResponse(responsesToOpenaiResponse(response, modelName), modelName);
  return response;
}

function responseMetadata(request: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const metadata = request?.["metadata"];
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined;
}

function responseParallelToolCalls(request: Record<string, unknown> | undefined): boolean | undefined {
  return typeof request?.["parallel_tool_calls"] === "boolean"
    ? request["parallel_tool_calls"] as boolean
    : undefined;
}

function responsesToOpenaiResponse(response: Record<string, unknown>, modelName: string): Record<string, unknown> {
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    if (obj["type"] === "message") {
      const content = obj["content"];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null) {
            const p = part as Record<string, unknown>;
            if (p["type"] === "output_text" && typeof p["text"] === "string") {
              textParts.push(p["text"]);
            }
          }
        }
      }
    } else if (obj["type"] === "function_call") {
      toolCalls.push({
        id: obj["call_id"] ?? obj["id"],
        type: "function",
        function: {
          name: obj["name"],
          arguments: obj["arguments"],
        },
      });
    }
  }

  const usage = response["usage"] as Record<string, unknown> | undefined;

  return {
    id: `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.join("") || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: response["status"] === "incomplete" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.["input_tokens"] ?? 0,
      completion_tokens: usage?.["output_tokens"] ?? 0,
      total_tokens: usage?.["total_tokens"] ?? 0,
    },
  };
}

function normalizeConvertedResponse(
  response: Record<string, unknown>,
  targetProtocol: "openai" | "anthropic" | "responses",
  modelName: string,
): Record<string, unknown> {
  if (targetProtocol === "anthropic") return response;
  if (targetProtocol === "responses") {
    const now = Math.floor(Date.now() / 1000);
    const normalized: Record<string, unknown> = { ...response };
    if (typeof normalized["id"] !== "string" || normalized["id"].length === 0) {
      normalized["id"] = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
    }
    if (typeof normalized["object"] !== "string" || normalized["object"].length === 0) {
      normalized["object"] = "response";
    }
    if (typeof normalized["created_at"] !== "number" || !Number.isFinite(normalized["created_at"])) {
      normalized["created_at"] = now;
    }
    if (typeof normalized["model"] !== "string" || normalized["model"].length === 0) {
      normalized["model"] = modelName;
    }
    return normalized;
  }
  const now = Math.floor(Date.now() / 1000);
  const normalized: Record<string, unknown> = { ...response };
  if (typeof normalized["id"] !== "string" || normalized["id"].length === 0) {
    normalized["id"] = `chatcmpl-${now}`;
  }
  if (typeof normalized["object"] !== "string" || normalized["object"].length === 0) {
    normalized["object"] = "chat.completion";
  }
  if (typeof normalized["created"] !== "number" || !Number.isFinite(normalized["created"])) {
    normalized["created"] = now;
  }
  if (typeof normalized["model"] !== "string" || normalized["model"].length === 0) {
    normalized["model"] = modelName;
  }
  if (Array.isArray(normalized["choices"])) {
    normalized["choices"] = normalized["choices"].map((choice, index) =>
      normalizeOpenAIChoice(choice, index),
    );
  }
  return normalized;
}

function normalizeOpenAIChoice(choice: unknown, index: number): unknown {
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return choice;
  const normalized: Record<string, unknown> = { ...(choice as Record<string, unknown>) };
  if (typeof normalized["index"] !== "number" || !Number.isFinite(normalized["index"])) {
    normalized["index"] = index;
  }
  const message = normalized["message"];
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    normalized["message"] = normalizeOpenAIMessage(message as Record<string, unknown>);
  }
  return normalized;
}

function normalizeOpenAIMessage(message: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...message };
  if (typeof normalized["role"] !== "string" || normalized["role"].length === 0) {
    normalized["role"] = "assistant";
  }
  const content = normalized["content"];
  if (
    content !== undefined &&
    typeof content !== "string" &&
    !Array.isArray(content) &&
    hasReasoningText(normalized)
  ) {
    normalized["content"] = "";
  }
  // Reasoning / chain-of-thought fields pass through untouched. Promoting
  // reasoning into "content" corrupts real reasoning models (duplicated
  // thinking text in the visible answer), so it is deliberately not done here.
  if (Array.isArray(normalized["tool_calls"])) {
    normalized["tool_calls"] = normalizeToolCalls(normalized["tool_calls"]);
  }
  return normalized;
}

function hasReasoningText(obj: Record<string, unknown>): boolean {
  for (const field of ["reasoning", "reasoning_content"]) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

function normalizeToolCalls(toolCalls: unknown[]): Array<Record<string, unknown>> {
  return toolCalls
    .filter((toolCall): toolCall is Record<string, unknown> =>
      typeof toolCall === "object" && toolCall !== null && !Array.isArray(toolCall),
    )
    .map((toolCall, index) => {
      const normalized: Record<string, unknown> = { ...toolCall };
      if (typeof normalized["id"] !== "string" || normalized["id"].length === 0) {
        normalized["id"] = `call_${index}`;
      }
      if (typeof normalized["type"] !== "string" || normalized["type"].length === 0) {
        normalized["type"] = "function";
      }
      const fn = normalized["function"];
      if (typeof fn === "object" && fn !== null && !Array.isArray(fn)) {
        const normalizedFn: Record<string, unknown> = { ...(fn as Record<string, unknown>) };
        if (typeof normalizedFn["name"] !== "string" || normalizedFn["name"].length === 0) {
          normalizedFn["name"] = "tool";
        }
        if (typeof normalizedFn["arguments"] !== "string") {
          normalizedFn["arguments"] = stringifyArguments(normalizedFn["arguments"]);
        }
        normalized["function"] = normalizedFn;
      } else {
        normalized["function"] = { name: "tool", arguments: "" };
      }
      return normalized;
    });
}

function stringifyArguments(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validateConvertedResponse(
  response: Record<string, unknown>,
  targetProtocol: "openai" | "anthropic" | "responses",
  route: ResolvedRoute,
): void {
  if (targetProtocol === "anthropic") return;
  if (targetProtocol === "responses") {
    const output = response["output"];
    if (!Array.isArray(output) || output.length === 0) {
      throwBadResponse(route, "missing output", response);
    }
    return;
  }
  const choices = response["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throwBadResponse(route, "missing choices", response);
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throwBadResponse(route, "malformed choice", response);
  }
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) {
    throwBadResponse(route, "missing assistant message", response);
  }
  const messageObj = message as Record<string, unknown>;
  const content = messageObj["content"];
  const toolCalls = messageObj["tool_calls"];
  const hasText =
    (typeof content === "string" && content.trim().length > 0) ||
    (Array.isArray(content) && content.length > 0);
  const hasReasoning = hasReasoningText(messageObj);
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (!hasText && !hasReasoning && !hasToolCalls) {
    throwBadResponse(route, "empty assistant message", response);
  }
}

function throwBadResponse(
  route: ResolvedRoute,
  reason: string,
  response: Record<string, unknown>,
): never {
  let body: string | undefined;
  try {
    body = JSON.stringify(response).slice(0, 1000);
  } catch {
    body = undefined;
  }
  throw new ProviderAPIError(
    `${route.provider} returned an unusable chat response: ${reason}`,
    502,
    { provider: route.provider, body },
  );
}

async function callProvider(
  provider: BaseProvider,
  protocol: "openai" | "anthropic" | "responses",
  request: Record<string, unknown>,
  route: ResolvedRoute,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const ctx = buildContext(route, signal);
  if (protocol === "anthropic") {
    if (provider.callAnthropic === undefined) {
      throw new Error(
        `Provider '${provider.providerName}' does not support Anthropic protocol`,
      );
    }
    return await provider.callAnthropic(anthropicArgsFromRequest(request, route.model), ctx);
  }
  if (protocol === "responses") {
    if (provider.callResponses === undefined) {
      throw new Error(
        `Provider '${provider.providerName}' does not support Responses protocol`,
      );
    }
    return await provider.callResponses(request as ResponsesCallArgs, ctx);
  }
  if (provider.callOpenAI === undefined) {
    throw new Error(
      `Provider '${provider.providerName}' does not support OpenAI protocol`,
    );
  }
  return await provider.callOpenAI(openaiArgsFromRequest(request, route.model), ctx);
}

async function* streamProvider(
  provider: BaseProvider,
  protocol: "openai" | "anthropic" | "responses",
  request: Record<string, unknown>,
  route: ResolvedRoute,
  signal: AbortSignal | undefined,
): AsyncGenerator<string, void, unknown> {
  const ctx = buildContext(route, signal);
  if (protocol === "anthropic") {
    if (provider.streamAnthropic === undefined) {
      throw new Error(
        `Provider '${provider.providerName}' does not support Anthropic streaming`,
      );
    }
    yield* provider.streamAnthropic(anthropicArgsFromRequest(request, route.model), ctx);
    return;
  }
  if (protocol === "responses") {
    if (provider.streamResponses === undefined) {
      throw new Error(
        `Provider '${provider.providerName}' does not support Responses streaming`,
      );
    }
    yield* provider.streamResponses(request as ResponsesCallArgs, ctx);
    return;
  }
  if (provider.streamOpenAI === undefined) {
    throw new Error(
      `Provider '${provider.providerName}' does not support OpenAI streaming`,
    );
  }
  yield* provider.streamOpenAI(openaiArgsFromRequest(request, route.model), ctx);
}

export async function execute({
  route,
  requestData,
  targetProtocol,
  signal,
  validateResponse = true,
}: ExecuteArgs): Promise<Record<string, unknown>> {
  const sourceProtocol = route.wireProtocol;
  log.debug("executing route", {
    provider: route.provider,
    model: route.model,
    sourceProtocol,
    targetProtocol,
  });

  try {
    const provider = providerRegistry.getProvider(route.provider);
    const converted = applyRouteBodyExtensions(
      convertRequest(requestData, targetProtocol, sourceProtocol),
      route,
    );
    const response = await callProvider(
      provider,
      sourceProtocol,
      converted,
      route,
      signal,
    );
    const modelName =
      typeof requestData["model"] === "string" ? (requestData["model"] as string) : route.model;
    const convertedResponse = normalizeConvertedResponse(
      convertResponse(response, sourceProtocol, targetProtocol, modelName, requestData),
      targetProtocol,
      modelName,
    );
    if (validateResponse) validateConvertedResponse(convertedResponse, targetProtocol, route);
    return convertedResponse;
  } catch (err) {
    if (err instanceof RouteExecutionError) throw err;
    throw wrapExecError(err, route);
  }
}

export async function* executeStream({
  route,
  requestData,
  targetProtocol,
  signal,
}: ExecuteArgs): AsyncGenerator<string, void, unknown> {
  const sourceProtocol = route.wireProtocol;
  log.debug("executing streaming route", {
    provider: route.provider,
    model: route.model,
    sourceProtocol,
    targetProtocol,
  });

  try {
    const provider = providerRegistry.getProvider(route.provider);
    const converted = applyRouteBodyExtensions(
      convertRequest(requestData, targetProtocol, sourceProtocol),
      route,
    );
    const sourceStream = streamProvider(provider, sourceProtocol, converted, route, signal);
    if (targetProtocol !== "responses" || sourceProtocol === "responses") {
      yield* sourceStream;
      return;
    }

    const state = createResponsesStreamState(
      typeof requestData["model"] === "string" ? requestData["model"] : route.model,
    );
    for await (const chunk of sourceStream) {
      const events = sourceProtocol === "anthropic"
        ? anthropicStreamChunkToResponsesEvents(chunk, state)
        : chatStreamChunkToResponsesEvents(chunk, state);
      for (const event of events) yield event;
    }
    for (const event of finalizeResponsesStream(state)) yield event;
  } catch (err) {
    if (err instanceof RouteExecutionError) throw err;
    throw wrapExecError(err, route);
  }
}

function wrapExecError(err: unknown, route: ResolvedRoute): RouteExecutionError {
  if (err instanceof ProviderTimeoutError) {
    return new RouteExecutionError(
      `Provider ${route.provider}/${route.model} timed out after ${Math.round(err.timeoutMs / 1000)}s`,
      { statusCode: 504, cause: err },
    );
  }
  if (err instanceof ProviderAPIError) {
    return new RouteExecutionError(
      `Provider ${route.provider}/${route.model} failed: ${err.message}`,
      { statusCode: err.status, cause: err },
    );
  }
  if (err instanceof Error) {
    return new RouteExecutionError(
      `Provider ${route.provider}/${route.model} failed: ${err.message}`,
      { cause: err },
    );
  }
  return new RouteExecutionError(
    `Provider ${route.provider}/${route.model} failed: ${String(err)}`,
    { cause: err },
  );
}
