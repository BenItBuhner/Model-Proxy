import {
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
} from "../format/converters.ts";
import { createLogger } from "../observability/logger.ts";
import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
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
  targetProtocol: "openai" | "anthropic";
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
  from: "openai" | "anthropic",
  to: "openai" | "anthropic",
): Record<string, unknown> {
  if (from === to) return request;
  if (from === "anthropic" && to === "openai") return anthropicToOpenaiRequest(request);
  if (from === "openai" && to === "anthropic") return openaiToAnthropicRequest(request);
  return request;
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
  from: "openai" | "anthropic",
  to: "openai" | "anthropic",
  modelName: string,
): Record<string, unknown> {
  if (from === to) return response;
  if (from === "openai" && to === "anthropic") return openaiToAnthropicResponse(response, modelName);
  if (from === "anthropic" && to === "openai") return anthropicToOpenaiResponse(response, modelName);
  return response;
}

function normalizeConvertedResponse(
  response: Record<string, unknown>,
  targetProtocol: "openai" | "anthropic",
  modelName: string,
): Record<string, unknown> {
  if (targetProtocol !== "openai") return response;
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
  targetProtocol: "openai" | "anthropic",
  route: ResolvedRoute,
): void {
  if (targetProtocol !== "openai") return;
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
  protocol: "openai" | "anthropic",
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
  if (provider.callOpenAI === undefined) {
    throw new Error(
      `Provider '${provider.providerName}' does not support OpenAI protocol`,
    );
  }
  return await provider.callOpenAI(openaiArgsFromRequest(request, route.model), ctx);
}

async function* streamProvider(
  provider: BaseProvider,
  protocol: "openai" | "anthropic",
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
      convertResponse(response, sourceProtocol, targetProtocol, modelName),
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
    yield* streamProvider(provider, sourceProtocol, converted, route, signal);
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
