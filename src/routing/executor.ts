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
import { ProviderAPIError, RouteExecutionError } from "../providers/errors.ts";
import { providerRegistry } from "../providers/registry.ts";
import type { ResolvedRoute } from "../../shared/schemas/routing.ts";

const log = createLogger("routing.executor");

export interface ExecuteArgs {
  route: ResolvedRoute;
  requestData: Record<string, unknown>;
  targetProtocol: "openai" | "anthropic";
  signal?: AbortSignal;
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
    const converted = convertRequest(requestData, targetProtocol, sourceProtocol);
    const response = await callProvider(
      provider,
      sourceProtocol,
      converted,
      route,
      signal,
    );
    const modelName =
      typeof requestData["model"] === "string" ? (requestData["model"] as string) : route.model;
    return convertResponse(response, sourceProtocol, targetProtocol, modelName);
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
    const converted = convertRequest(requestData, targetProtocol, sourceProtocol);
    yield* streamProvider(provider, sourceProtocol, converted, route, signal);
  } catch (err) {
    if (err instanceof RouteExecutionError) throw err;
    throw wrapExecError(err, route);
  }
}

function wrapExecError(err: unknown, route: ResolvedRoute): RouteExecutionError {
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
