import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  OpenAIChatCompletionRequest,
  OpenAIResponsesRequest,
} from "../../../shared/schemas/openai-wire.ts";
import { RoutingError, type ModelRoutingConfig } from "../../../shared/schemas/routing.ts";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  modelConfigLoader,
} from "../../config/model-loader.ts";
import {
  chatResponseToResponses,
  chatStreamChunkToResponsesEvents,
  createResponsesStreamState,
  finalizeResponsesStream,
  responsesStreamStateToChatResponse,
  responsesRequestToChat,
  responsesInputItemsForStorage,
} from "../../format/responses.ts";
import {
  getGlobalResponseStore,
  previousResponseNotFoundError,
} from "../../format/response-store.ts";
import { createLogger } from "../../observability/logger.ts";
import {
  emit,
  nowIso,
  runWithRequestContext,
} from "../../observability/request-context.ts";
import { StreamUsageTracker } from "../../observability/stream-usage.ts";
import { reserveRequest } from "../../storage/limit-store.ts";
import { RouteExecutionError } from "../../providers/errors.ts";
import {
  EnforceRouter,
  EnforceValidationError,
} from "../../routing/enforce/index.ts";
import {
  buildLogicalModelListEntry,
  buildOpenAIModelListEntry,
  SYSTEM_DEFAULT_CONTEXT_WINDOW,
} from "../../routing/context-window.ts";
import {
  AccessDeniedError,
  assertCanUseLogicalModel,
  canListModel,
} from "../../policy/access-control.ts";
import { FallbackRouter } from "../../routing/fallback.ts";
import { getProviderWireProtocol } from "../../providers/provider-helpers.ts";
import { FusionRouter } from "../../routing/fusion/fusion-router.ts";
import type { FusionRequestContext } from "../../routing/fusion/types.ts";
import { principal, requireAuth } from "../auth.ts";
import { formatOpenAIError } from "../error-formatters.ts";
import {
  estimateRequestTokens,
  recordRequestAbort,
  recordRequestFinish,
  recordRequestProgress,
  recordRequestStart,
} from "../request-log.ts";

const log = createLogger("routes.openai");
const MAX_CAPTURED_STREAM_CHARS = parsePositiveInt(process.env.STREAM_CAPTURE_MAX_CHARS) ?? 250_000;
const STREAM_HEARTBEAT_MS = parsePositiveInt(process.env.STREAM_HEARTBEAT_MS) ?? 5_000;

function routingErrorStatus(err: RoutingError): {
  status: ContentfulStatusCode;
  type: "service_unavailable" | "gateway_timeout";
} {
  const statuses = err.errors
    .map((entry) => entry["status_code"])
    .filter((status): status is number => typeof status === "number");
  if (statuses.length > 0 && statuses.every((status) => status === 504)) {
    return { status: 504, type: "gateway_timeout" };
  }
  return { status: 503, type: "service_unavailable" };
}

function buildUpstreamExtraHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = c.req.header("x-opencode-session") ?? c.req.header("x-session-affinity");
  if (session !== undefined && session.length > 0) {
    headers["x-opencode-session"] = session;
  }
  const opencodeRequest = c.req.header("x-opencode-request");
  if (opencodeRequest !== undefined && opencodeRequest.length > 0) {
    headers["x-opencode-request"] = opencodeRequest;
  }
  const opencodeClient = c.req.header("x-opencode-client");
  if (opencodeClient !== undefined && opencodeClient.length > 0) {
    headers["x-opencode-client"] = opencodeClient;
  }
  const project = c.req.header("x-opencode-project");
  if (project !== undefined && project.length > 0) {
    headers["x-opencode-project"] = project;
  }
  const userAgent = c.req.header("user-agent");
  if (userAgent !== undefined && userAgent.length > 0) {
    headers["User-Agent"] = userAgent;
  }
  return headers;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Build the full chat-message array that should be stored for a response:
 * the chat body messages plus the assistant response message(s).
 */
function buildStoredMessages(
  chatMessages: Array<Record<string, unknown>>,
  chatResponse: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const messages = [...chatMessages];
  const choices = Array.isArray(chatResponse["choices"]) ? chatResponse["choices"] : [];
  for (const choice of choices) {
    if (typeof choice === "object" && choice !== null) {
      const msg = (choice as Record<string, unknown>)["message"];
      if (typeof msg === "object" && msg !== null) {
        messages.push(msg as Record<string, unknown>);
      }
    }
  }
  return messages;
}

function responsesResponseToChatResponse(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  const content: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const raw of output) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item["type"] === "message" && Array.isArray(item["content"])) {
      for (const rawPart of item["content"] as unknown[]) {
        if (typeof rawPart !== "object" || rawPart === null || Array.isArray(rawPart)) continue;
        const part = rawPart as Record<string, unknown>;
        if (part["type"] === "output_text" && typeof part["text"] === "string") {
          content.push({ type: "text", text: part["text"] });
        }
      }
    } else if (item["type"] === "function_call") {
      toolCalls.push({
        id: item["call_id"] ?? item["id"],
        type: "function",
        function: {
          name: item["name"],
          arguments: item["arguments"] ?? "",
        },
      });
    }
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  const usage = response["usage"];
  return {
    id: typeof response["id"] === "string" ? response["id"] : `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: typeof response["created_at"] === "number" ? response["created_at"] : Math.floor(Date.now() / 1000),
    model: response["model"],
    choices: [{
      index: 0,
      message,
      finish_reason: response["status"] === "incomplete" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    ...(typeof usage === "object" && usage !== null ? {
      usage: {
        prompt_tokens: (usage as Record<string, unknown>)["input_tokens"] ?? 0,
        completion_tokens: (usage as Record<string, unknown>)["output_tokens"] ?? 0,
        total_tokens: (usage as Record<string, unknown>)["total_tokens"] ?? 0,
      },
    } : {}),
  };
}

function completedResponseFromSseChunk(chunk: string): Record<string, unknown> | undefined {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed["type"] === "response.completed") {
        const response = parsed["response"];
        if (typeof response === "object" && response !== null && !Array.isArray(response)) {
          return response as Record<string, unknown>;
        }
      }
    } catch {
      // Partial or provider-specific SSE frames are ignored here.
    }
  }
  return undefined;
}

function shouldPersistCompletion(modelOverride: boolean | undefined): boolean {
  if (modelOverride !== undefined) return modelOverride;
  return /^(1|true|yes|on)$/i.test(process.env.PERSIST_COMPLETIONS?.trim() ?? "");
}

function completionPersistenceForRequest(
  p: ReturnType<typeof principal>,
  modelOverride: boolean | undefined,
): boolean | undefined {
  if (p === undefined || p.isOwner) return modelOverride;
  return p.completionLoggingEnabled === true;
}

function responseOwnerId(p: ReturnType<typeof principal>): string | undefined {
  return p?.userId ?? p?.id;
}

export function createOpenAIRoutes(): Hono {
  const app = new Hono();
  // Scope auth to OpenAI-only paths so this router does not gate
  // admin/auth/health endpoints when mounted at root.
  app.use("/v1/models", requireAuth({ allowSession: true }));
  app.use("/v1/chat/*", requireAuth({ allowSession: true }));
  app.use("/v1/responses", requireAuth({ allowSession: true }));
  app.use("/v1/responses/*", requireAuth({ allowSession: true }));

  app.get("/v1/models", async (c) => {
    const p = principal(c);
    const models = modelConfigLoader.getAvailableModels().filter((name) => canListModel(p, name));
    const data = await Promise.all(
      models.map(async (name) => {
        try {
          return await buildLogicalModelListEntry(name);
        } catch (err) {
          log.warn("failed to resolve model for listing", {
            name,
            err: String(err),
          });
          return buildOpenAIModelListEntry(
            name,
            SYSTEM_DEFAULT_CONTEXT_WINDOW,
            "unknown",
          );
        }
      }),
    );
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) =>
    handleChatCompletions(c, "/v1/chat/completions"),
  );

  app.post("/v1/chat/completions/stream", async (c) =>
    handleChatCompletions(c, "/v1/chat/completions/stream", { forceStream: true }),
  );

  app.post("/v1/responses", async (c) => handleResponsesNative(c, "/v1/responses"));

  app.get("/v1/responses/:responseId", (c) => {
    const responseId = c.req.param("responseId");
    const entry = getGlobalResponseStore().get(responseId, responseOwnerId(principal(c)));
    if (entry === undefined) {
      return c.json(previousResponseNotFoundError(responseId), 404);
    }
    return c.json(entry.response);
  });

  app.delete("/v1/responses/:responseId", (c) => {
    const responseId = c.req.param("responseId");
    const store = getGlobalResponseStore();
    const ownerId = responseOwnerId(principal(c));
    if (store.get(responseId, ownerId) === undefined) {
      return c.json(previousResponseNotFoundError(responseId), 404);
    }
    store.delete(responseId, ownerId);
    return c.json({ id: responseId, object: "response", deleted: true });
  });

  return app;
}

/** First-class Responses route. The router may use native Responses upstreams or
 * convert the request through the existing OpenAI/Anthropic provider paths. */
async function handleResponsesNative(c: Context, endpointPath: string): Promise<Response> {
  const requestId = c.get("requestId");
  const p = principal(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(formatOpenAIError(400, "Invalid JSON body", "invalid_request_error"), 400);
  }
  const parsed = OpenAIResponsesRequest.safeParse(body);
  if (!parsed.success) {
    return c.json(formatOpenAIError(400, `Invalid request: ${parsed.error.message}`, "invalid_request_error"), 400);
  }

  const inputRequest = parsed.data as Record<string, unknown>;
  const storeEnabled = inputRequest["store"] !== false;
  const effectiveRequest = { ...inputRequest };
  const previousId = typeof inputRequest["previous_response_id"] === "string"
    ? inputRequest["previous_response_id"]
    : undefined;
  if (previousId !== undefined) {
    const previous = getGlobalResponseStore().get(previousId, responseOwnerId(p));
    if (previous === undefined) {
      return c.json(previousResponseNotFoundError(previousId), 400);
    }
    // Rehydrate locally so the same semantics work for native Responses,
    // OpenAI-compatible, and Anthropic upstreams alike.
    effectiveRequest["input"] = previous.inputItems ?? previous.messages;
    const currentInput = inputRequest["input"];
    if (currentInput !== undefined) {
      const history = Array.isArray(effectiveRequest["input"])
        ? [...effectiveRequest["input"] as unknown[]]
        : [effectiveRequest["input"]];
      const additions = Array.isArray(currentInput) ? currentInput : [currentInput];
      effectiveRequest["input"] = [...history, ...additions];
    }
    delete effectiveRequest["previous_response_id"];
  }

  const model = effectiveRequest["model"];
  if (typeof model !== "string" || model.length === 0) {
    return c.json(formatOpenAIError(400, "model is required", "invalid_request_error"), 400);
  }
  const requestDict = { ...effectiveRequest };
  const isStream = requestDict["stream"] === true;
  const estimatedPromptTokens = estimateRequestTokens(requestDict);
  try {
    assertCanUseLogicalModel(p, model);
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      return c.json(formatOpenAIError(404, `Model '${model}' not found`, "invalid_request_error"), 404);
    }
    throw err;
  }
  const limitDecision = reserveRequest(p, estimatedPromptTokens ?? 0);
  if (!limitDecision.allowed) {
    return c.json(formatOpenAIError(429, limitDecision.reason ?? "Rate limit exceeded", "rate_limit_exceeded"), 429);
  }

  let modelConfig: ModelRoutingConfig;
  try {
    modelConfig = modelConfigLoader.loadConfig(model);
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigParseError || err instanceof ConfigValidationError) {
      return c.json(formatOpenAIError(400, `Model '${model}' not found in routing configuration`, "invalid_request_error"), 400);
    }
    throw err;
  }

  const hasNativeResponsesRoute = modelConfig.model_routings.some((routing) => {
    if (routing.wire_protocol === "responses") return true;
    if (routing.wire_protocol !== undefined) return false;
    try {
      return getProviderWireProtocol(routing.provider) === "responses";
    } catch {
      return false;
    }
  });
  if (requestDict["background"] === true && !hasNativeResponsesRoute) {
    return c.json(
      formatOpenAIError(400, "background Responses are only supported by native Responses routes", "invalid_request_error"),
      400,
    );
  }
  if (requestDict["conversation"] !== undefined && !hasNativeResponsesRoute) {
    return c.json(
      formatOpenAIError(400, "conversation state is only supported by native Responses routes", "invalid_request_error"),
      400,
    );
  }

  if (modelConfig.fusion?.enabled === true) {
    return handleResponsesFusion(c, requestDict, model, modelConfig, isStream, endpointPath);
  }

  recordRequestStart({
    requestId,
    endpoint: endpointPath,
    method: "POST",
    requestedModel: model,
    resolvedModel: model,
    wireProtocol: "responses",
    isStreaming: isStream,
    enforceMode: false,
    promptTokens: estimatedPromptTokens,
    promptTokensEstimated: true,
    requestBody: inputRequest,
    persistCompletions: completionPersistenceForRequest(p, undefined),
    userId: p?.userId,
    apiKeyId: p?.apiKeyId,
    principalRole: p?.role,
    ownerBypass: p?.ownerBypass,
  });
  emit({
    type: "request.started",
    at: nowIso(),
    protocol: "responses",
    endpoint: endpointPath,
    model,
    stream: isStream,
    enforceEnabled: false,
  });

  const fallback = new FallbackRouter({ principal: p });
  const extraHeaders = buildUpstreamExtraHeaders(c);
  const signal = c.req.raw.signal;

  if (isStream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let completed: Record<string, unknown> | undefined;
        const started = performance.now();
        try {
          const generator = fallback.streamWithFallback({
            logicalModel: model,
            requestData: requestDict,
            targetProtocol: "responses",
            extraHeaders,
            ...(signal !== undefined ? { signal } : {}),
            ...(p !== undefined ? { principal: p } : {}),
          });
          for await (const chunk of generator) {
            completed = completedResponseFromSseChunk(chunk) ?? completed;
            const bytes = encoder.encode(chunk);
            controller.enqueue(bytes);
            recordRequestProgress({ requestId, streamBytes: bytes.byteLength, streamChunkCount: 1 });
          }
          if (storeEnabled && completed !== undefined && typeof completed["id"] === "string") {
            const chatRequest = responsesRequestToChat(requestDict);
            const chatResponse = responsesResponseToChatResponse(completed);
            getGlobalResponseStore().set({
              id: completed["id"] as string,
              ownerId: responseOwnerId(p),
              model,
              createdAt: typeof completed["created_at"] === "number" ? completed["created_at"] : Math.floor(Date.now() / 1000),
              status: typeof completed["status"] === "string" ? completed["status"] : "completed",
              messages: buildStoredMessages((chatRequest["messages"] as Array<Record<string, unknown>>) ?? [], chatResponse),
              inputItems: responsesInputItemsForStorage(requestDict, completed),
              response: completed,
              store: true,
            });
          }
          controller.close();
          const totalMs = Math.round(performance.now() - started);
          recordRequestFinish({ requestId, responseStatus: 200, responseTimeMs: totalMs });
          emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });
        } catch (err) {
          const status = err instanceof RoutingError ? routingErrorStatus(err).status : err instanceof RouteExecutionError ? (err.statusCode ?? 502) : 500;
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message } })}\n\n`));
          controller.close();
          const totalMs = Math.round(performance.now() - started);
          recordRequestFinish({ requestId, responseStatus: status, responseTimeMs: totalMs, errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
          emit({ type: "request.finished", at: nowIso(), status, totalMs, errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const started = performance.now();
  try {
    const response = await fallback.callWithFallback({
      logicalModel: model,
      requestData: requestDict,
      targetProtocol: "responses",
      extraHeaders,
      ...(signal !== undefined ? { signal } : {}),
      ...(p !== undefined ? { principal: p } : {}),
    });
    if (storeEnabled && typeof response["id"] === "string") {
      const chatRequest = responsesRequestToChat(requestDict);
      const chatResponse = responsesResponseToChatResponse(response);
      getGlobalResponseStore().set({
        id: response["id"] as string,
        ownerId: responseOwnerId(p),
        model,
        createdAt: typeof response["created_at"] === "number" ? response["created_at"] : Math.floor(Date.now() / 1000),
        status: typeof response["status"] === "string" ? response["status"] : "completed",
        messages: buildStoredMessages((chatRequest["messages"] as Array<Record<string, unknown>>) ?? [], chatResponse),
        inputItems: responsesInputItemsForStorage(requestDict, response),
        response,
        store: true,
      });
    }
    const usage = typeof response["usage"] === "object" && response["usage"] !== null ? response["usage"] as Record<string, unknown> : {};
    recordRequestFinish({
      requestId,
      responseStatus: 200,
      responseTimeMs: Math.round(performance.now() - started),
      responseBody: response,
      promptTokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined,
      completionTokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
      totalTokens: typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : undefined,
    });
    emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: Math.round(performance.now() - started) });
    return c.json(response);
  } catch (err) {
    const status = err instanceof RoutingError ? routingErrorStatus(err).status : err instanceof RouteExecutionError ? (err.statusCode ?? 502) : 500;
    const message = err instanceof Error ? err.message : String(err);
    recordRequestFinish({ requestId, responseStatus: status, responseTimeMs: Math.round(performance.now() - started), errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
    emit({ type: "request.finished", at: nowIso(), status, totalMs: Math.round(performance.now() - started), errorMessage: message, errorType: err instanceof Error ? err.name : "Unknown" });
    return c.json(formatOpenAIError(status, message, status >= 500 ? "api_error" : "invalid_request_error"), status as ContentfulStatusCode);
  }
}

/** Run the existing fusion engine on its canonical chat representation while
 * keeping the public Responses response and event contract. */
async function handleResponsesFusion(
  c: Context,
  requestData: Record<string, unknown>,
  model: string,
  modelConfig: ModelRoutingConfig,
  isStream: boolean,
  endpointPath: string,
): Promise<Response> {
  const fusionResponse = await handleFusionRequest(
    c,
    responsesRequestToChat(requestData),
    model,
    modelConfig,
    isStream,
    endpointPath,
  );
  if (!isStream || fusionResponse.body === null) {
    if (isStream) return fusionResponse;
    const body = await fusionResponse.json() as Record<string, unknown>;
    if (!Array.isArray(body["choices"])) return c.json(body, fusionResponse.status as ContentfulStatusCode);
    const response = chatResponseToResponses(body, {
      model,
      metadata: typeof requestData["metadata"] === "object" && requestData["metadata"] !== null
        ? requestData["metadata"] as Record<string, unknown>
        : undefined,
      parallelToolCalls: typeof requestData["parallel_tool_calls"] === "boolean"
        ? requestData["parallel_tool_calls"]
        : undefined,
      requestTools: Array.isArray(requestData["tools"]) ? requestData["tools"] : undefined,
    });
    if (requestData["store"] !== false && typeof response["id"] === "string") {
      const chatRequest = responsesRequestToChat(requestData);
      getGlobalResponseStore().set({
        id: response["id"] as string,
        ownerId: responseOwnerId(principal(c)),
        model,
        createdAt: typeof response["created_at"] === "number" ? response["created_at"] : Math.floor(Date.now() / 1000),
        status: typeof response["status"] === "string" ? response["status"] : "completed",
        messages: buildStoredMessages((chatRequest["messages"] as Array<Record<string, unknown>>) ?? [], body),
        inputItems: responsesInputItemsForStorage(requestData, response),
        response,
        store: true,
      });
    }
    return c.json(response, fusionResponse.status as ContentfulStatusCode);
  }

  const state = createResponsesStreamState(
    model,
    undefined,
    Array.isArray(requestData["tools"]) ? requestData["tools"] : undefined,
  );
  const reader = fusionResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split(/(?=data: )/);
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            for (const event of chatStreamChunkToResponsesEvents(chunk, state)) {
              controller.enqueue(encoder.encode(event));
            }
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          for (const event of chatStreamChunkToResponsesEvents(buffer, state)) {
            controller.enqueue(encoder.encode(event));
          }
        }
        for (const event of finalizeResponsesStream(state)) {
          controller.enqueue(encoder.encode(event));
        }
        const response = chatResponseToResponses(responsesStreamStateToChatResponse(state), {
          model,
          requestTools: Array.isArray(requestData["tools"]) ? requestData["tools"] : undefined,
        });
        if (requestData["store"] !== false && typeof response["id"] === "string") {
          const chatRequest = responsesRequestToChat(requestData);
          getGlobalResponseStore().set({
            id: response["id"] as string,
            ownerId: responseOwnerId(principal(c)),
            model,
            createdAt: typeof response["created_at"] === "number" ? response["created_at"] : Math.floor(Date.now() / 1000),
            status: typeof response["status"] === "string" ? response["status"] : "completed",
            messages: buildStoredMessages((chatRequest["messages"] as Array<Record<string, unknown>>) ?? [], responsesStreamStateToChatResponse(state)),
            inputItems: responsesInputItemsForStorage(requestData, response),
            response,
            store: true,
          });
        }
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message } })}\n\n`));
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(stream, {
    status: fusionResponse.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

async function handleChatCompletions(
  c: Context,
  endpointPath: string,
  options: { forceStream?: boolean } = {},
): Promise<Response> {
  const requestId = c.get("requestId");
  const startedAt = c.get("startedAt");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      formatOpenAIError(400, "Invalid JSON body", "invalid_request_error"),
      400,
    );
  }

  const parsed = OpenAIChatCompletionRequest.safeParse(body);
  if (!parsed.success) {
    return c.json(
      formatOpenAIError(
        400,
        `Invalid request: ${parsed.error.message}`,
        "invalid_request_error",
      ),
      400,
    );
  }

  const request = parsed.data;
  const requestDict: Record<string, unknown> = { ...request };
  if (options.forceStream) requestDict["stream"] = true;
  const isStream = Boolean(requestDict["stream"]);
  const p = principal(c);
  const estimatedPromptTokens = estimateRequestTokens(requestDict);
  try {
    assertCanUseLogicalModel(p, request.model);
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      return c.json(
        formatOpenAIError(404, `Model '${request.model}' not found`, "invalid_request_error"),
        404,
      );
    }
    throw err;
  }
  const limitDecision = reserveRequest(p, estimatedPromptTokens ?? 0);
  if (!limitDecision.allowed) {
    return c.json(
      formatOpenAIError(429, limitDecision.reason ?? "Rate limit exceeded", "rate_limit_exceeded"),
      429,
    );
  }

  // Confirm the logical model is known up front.
  let modelConfig: ModelRoutingConfig;
  try {
    modelConfig = modelConfigLoader.loadConfig(request.model);
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigParseError || err instanceof ConfigValidationError) {
      const available = modelConfigLoader.getAvailableModels().join(", ") || "(none)";
      return c.json(
        formatOpenAIError(
          400,
          `Model '${request.model}' not found in routing configuration. Available models: ${available}`,
          "invalid_request_error",
        ),
        400,
      );
    }
    throw err;
  }

  // ── Fusion dispatch ───────────────────────────────────────────────
  if (modelConfig.fusion?.enabled === true) {
    return runWithRequestContext(requestId, () => handleFusionRequest(c, requestDict, request.model, modelConfig, isStream, endpointPath));
  }

  const fallback = new FallbackRouter({ principal: p });
  const enforce = new EnforceRouter(fallback);
  const overrides = {
    header: c.req.header("x-enforce-tool-call"),
    query: c.req.query("enforce_tool_call"),
  };
  const enforceConfig = enforce.resolveConfig({
    logicalModel: request.model,
    overrides,
  });
  const persistCompletions = completionPersistenceForRequest(p, modelConfig.persist_completions);

  recordRequestStart({
    requestId,
    endpoint: endpointPath,
    method: "POST",
    requestedModel: request.model,
    resolvedModel: request.model,
    wireProtocol: "openai",
    isStreaming: isStream,
    enforceMode: enforceConfig.enabled,
    promptTokens: estimatedPromptTokens,
    promptTokensEstimated: true,
    requestBody: requestDict,
    persistCompletions,
    userId: p?.userId,
    apiKeyId: p?.apiKeyId,
    principalRole: p?.role,
    ownerBypass: p?.ownerBypass,
  });

  const signal = c.req.raw.signal;
  const recordAbort = () => {
    recordRequestAbort({
      requestId,
      responseTimeMs: Math.round(performance.now() - startedAt),
    });
  };
  if (signal.aborted) {
    recordAbort();
  } else {
    signal.addEventListener("abort", recordAbort, { once: true });
  }
  const extraHeaders = buildUpstreamExtraHeaders(c);
  const captureStreamPayload = shouldPersistCompletion(persistCompletions);

  if (isStream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const enqueueHeartbeat = () => {
          try {
            controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          } catch {
            // The stream may already be closed or cancelled.
          }
        };
        // Flush immediately so Cloudflare sees response bytes while slow
        // upstreams are still processing the prompt or cycling fallbacks.
        enqueueHeartbeat();
        const heartbeat = setInterval(enqueueHeartbeat, STREAM_HEARTBEAT_MS);
        // Nested run() so async generator iteration (which happens lazily
        // here, after the outer request handler returned) still resolves
        // `currentEmitter()` correctly for every emit call deep in the stack.
        try {
          await runWithRequestContext(requestId, async () => {
            emit({
              type: "request.started",
              at: nowIso(),
              protocol: "openai",
              endpoint: endpointPath,
              model: request.model,
              stream: true,
              enforceEnabled: enforceConfig.enabled,
            });
            try {
              const streamUsage = new StreamUsageTracker("openai", {
                captureText: captureStreamPayload,
                maxCapturedChars: MAX_CAPTURED_STREAM_CHARS,
              });
              const generator = enforceConfig.enabled
                ? enforce.stream({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "openai",
                    overrides,
                    extraHeaders,
                    ...(p !== undefined ? { principal: p } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                  })
                : fallback.streamWithFallback({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "openai",
                    extraHeaders,
                    ...(p !== undefined ? { principal: p } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                  });
              for await (const chunk of generator) {
                streamUsage.ingest(chunk);
                const encoded = encoder.encode(chunk);
                controller.enqueue(encoded);
                recordRequestProgress({
                  requestId,
                  streamBytes: encoded.byteLength,
                  streamChunkCount: 1,
                });
              }
              controller.close();
              const totalMs = Math.round(performance.now() - startedAt);
              emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });
              const usageResult = streamUsage.finish();
              recordRequestFinish({
                requestId,
                responseStatus: 200,
                responseTimeMs: totalMs,
                responseBody: usageResult.capturedText,
                completionTokens: usageResult.completionTokens,
                completionTokensEstimated: usageResult.completionTokensEstimated,
                usage: usageResult.usage,
              });
            } catch (err) {
              const routingStatus = err instanceof RoutingError ? routingErrorStatus(err) : undefined;
              const status = routingStatus?.status ?? 500;
              const type = routingStatus?.type ?? "internal_server_error";
              const message =
                err instanceof Error ? err.message : `Streaming error: ${String(err)}`;
              const errorPayload = formatOpenAIError(status, message, type);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              const totalMs = Math.round(performance.now() - startedAt);
              const errorType = err instanceof Error ? err.name : "Unknown";
              emit({
                type: "request.finished",
                at: nowIso(),
                status,
                totalMs,
                errorType,
                errorMessage: message,
              });
              recordRequestFinish({
                requestId,
                responseStatus: status,
                responseTimeMs: totalMs,
                errorMessage: message,
                errorType,
                responseBody: errorPayload,
              });
            }
          });
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return runWithRequestContext(requestId, async () => {
    emit({
      type: "request.started",
      at: nowIso(),
      protocol: "openai",
      endpoint: endpointPath,
      model: request.model,
      stream: false,
      enforceEnabled: enforceConfig.enabled,
    });
    try {
      const response = enforceConfig.enabled
        ? await enforce.call({
            logicalModel: request.model,
            requestData: requestDict,
            targetProtocol: "openai",
            overrides,
            extraHeaders,
            ...(p !== undefined ? { principal: p } : {}),
            ...(signal !== undefined ? { signal } : {}),
          })
        : await fallback.callWithFallback({
            logicalModel: request.model,
            requestData: requestDict,
            targetProtocol: "openai",
            extraHeaders,
            ...(p !== undefined ? { principal: p } : {}),
            ...(signal !== undefined ? { signal } : {}),
          });
      // Preserve the client-visible model name.
      const responseObj: Record<string, unknown> = { ...response, model: request.model };

      const usage = responseObj["usage"];
      const usageObj =
        typeof usage === "object" && usage !== null
          ? (usage as Record<string, unknown>)
          : {};
      const totalMs = Math.round(performance.now() - startedAt);
      const finish: Parameters<typeof recordRequestFinish>[0] = {
        requestId,
        responseStatus: 200,
        responseTimeMs: totalMs,
        responseBody: responseObj,
      };
      const prompt = usageObj["prompt_tokens"];
      const completion = usageObj["completion_tokens"];
      const total = usageObj["total_tokens"];
      if (typeof prompt === "number") finish.promptTokens = prompt;
      if (typeof completion === "number") finish.completionTokens = completion;
      if (typeof total === "number") finish.totalTokens = total;
      recordRequestFinish(finish);
      emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });

      return c.json(responseObj);
    } catch (err) {
      const totalMs = Math.round(performance.now() - startedAt);
      if (err instanceof RoutingError) {
        const message = `All routes failed for model '${request.model}': ${err.summary()}`;
        const { status, type } = routingErrorStatus(err);
        recordRequestFinish({
          requestId,
          responseStatus: status,
          responseTimeMs: totalMs,
          errorMessage: message,
          errorType: err.name,
          responseBody: formatOpenAIError(status, message, type),
        });
        emit({
          type: "request.finished",
          at: nowIso(),
          status,
          totalMs,
          errorType: err.name,
          errorMessage: message,
        });
        return c.json(formatOpenAIError(status, message, type), status);
      }
      if (err instanceof RouteExecutionError) {
        const status = (err.statusCode ?? 502) as ContentfulStatusCode;
        recordRequestFinish({
          requestId,
          responseStatus: status,
          responseTimeMs: totalMs,
          errorMessage: err.message,
          errorType: err.name,
          responseBody: formatOpenAIError(status, err.message),
        });
        emit({
          type: "request.finished",
          at: nowIso(),
          status,
          totalMs,
          errorType: err.name,
          errorMessage: err.message,
        });
        return c.json(formatOpenAIError(status, err.message), status);
      }
      if (err instanceof EnforceValidationError) {
        const message = `Enforce tool-call validation failed after ${err.attempts} attempts: ${err.lastReason}`;
        recordRequestFinish({
          requestId,
          responseStatus: 502,
          responseTimeMs: totalMs,
          errorMessage: message,
          errorType: err.name,
          responseBody: formatOpenAIError(502, message, "api_error"),
        });
        emit({
          type: "request.finished",
          at: nowIso(),
          status: 502,
          totalMs,
          errorType: err.name,
          errorMessage: message,
        });
        return c.json(formatOpenAIError(502, message, "api_error"), 502);
      }
      log.error("unexpected error in chat_completions", { err });
      const message = err instanceof Error ? err.message : String(err);
      const errType = err instanceof Error ? err.name : "Unknown";
      recordRequestFinish({
        requestId,
        responseStatus: 500,
        responseTimeMs: totalMs,
        errorMessage: message,
        errorType: errType,
        responseBody: formatOpenAIError(500, `Error processing request: ${message}`, "internal_server_error"),
      });
      emit({
        type: "request.finished",
        at: nowIso(),
        status: 500,
        totalMs,
        errorType: errType,
        errorMessage: message,
      });
      return c.json(
        formatOpenAIError(500, `Error processing request: ${message}`, "internal_server_error"),
        500,
      );
    }
  });
}

// ── Fusion dispatch handler ──────────────────────────────────────────

/**
 * Handle a chat completion request routed through the Model Fusion (Beta) system.
 * Properly wired into the observability event sink with lifecycle events,
 * usage tracking, and completion persistence.
 */
async function handleFusionRequest(
  c: Context,
  requestDict: Record<string, unknown>,
  logicalModel: string,
  modelConfig: ModelRoutingConfig,
  isStream: boolean,
  _endpointPath: string,
): Promise<Response> {
  const requestId: string = c.get("requestId");
  const fusionConfig = modelConfig.fusion;
  const p = principal(c);
  const persistCompletions = completionPersistenceForRequest(p, modelConfig.persist_completions);
  if (!fusionConfig?.enabled) {
    return c.json(
      formatOpenAIError(400, "Fusion not enabled for this model", "invalid_request_error"),
      400,
    );
  }

  const fusionRouter = new FusionRouter();
  const messages = (requestDict["messages"] as unknown[]) ?? [];
  const extraHeaders = buildUpstreamExtraHeaders(c);

  const fusionCtx: FusionRequestContext = {
    logicalModel,
    fusionConfig,
    requestData: requestDict,
    clientProtocol: "openai",
    messages,
    signal: c.req.raw.signal,
    requestId,
    extraHeaders,
    ...(p !== undefined ? { principal: p } : {}),
  };

  // NOTE: The caller (route handler) already wraps in runWithRequestContext,
  // so emit() will find the existing ALS context. No need to wrap again here.
  // Emit request.started event — field names must match server-side RequestEvent type
  emit({
    type: "request.started",
    at: nowIso(),
    protocol: "openai",
    endpoint: "/v1/chat/completions",
    model: logicalModel,
    stream: isStream,
    enforceEnabled: false,
  });

    // Record the fusion-specific request start without forcing payload storage.
    recordRequestStart({
      requestId,
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: logicalModel,
      resolvedModel: logicalModel,
      wireProtocol: "openai",
      isStreaming: isStream,
      enforceMode: false,
      promptTokens: estimateRequestTokens(requestDict),
      promptTokensEstimated: true,
      requestBody: requestDict,
      persistCompletions,
      userId: p?.userId,
      apiKeyId: p?.apiKeyId,
      principalRole: p?.role,
      ownerBypass: p?.ownerBypass,
    });

    if (isStream) {
      return handleFusionStream(c, fusionRouter, fusionCtx, requestId);
    }

    // Non-streaming path
    try {
      const startedAt = c.get("startedAt") as number;
      const result = await fusionRouter.route(fusionCtx);
      const responseTimeMs = Math.round(performance.now() - startedAt);

      // Emit route events from the fusion result — field names must match server-side RequestEvent type
      emit({
        type: "route.attempted",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: result.fusedByModelRouting || logicalModel,
        wireProtocol: "openai",
        isFallback: false,
        keyHint: "fusion",
      });
      emit({
        type: "route.succeeded",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: result.fusedByModelRouting || logicalModel,
        latencyMs: responseTimeMs,
      });

      // Build an OpenAI-compatible response
      const message: Record<string, unknown> = {
        role: "assistant",
      };

      if (result.toolCalls && result.toolCalls.length > 0) {
        message.content = result.content || null;
        message.tool_calls = result.toolCalls;
      } else {
        message.content = result.content;
      }
      if (result.reasoning !== undefined) {
        message.reasoning = result.reasoning;
      }
      if (result.reasoningContent !== undefined) {
        message.reasoning_content = result.reasoningContent;
      }

      const openaiResponse: Record<string, unknown> = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: logicalModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.finishReason || "stop",
          },
        ],
        usage: result.usage ?? {
          prompt_tokens: estimateRequestTokens(requestDict) ?? 0,
          completion_tokens: result.content ? Math.ceil(result.content.length / 4) : (result.toolCalls ? String(result.toolCalls).length / 4 : 0),
          total_tokens: (estimateRequestTokens(requestDict) ?? 0) + (result.content ? Math.ceil(result.content.length / 4) : (result.toolCalls ? String(result.toolCalls).length / 4 : 0)),
        },
      };

      // Attach the full fusion trace for analytics/observability
      if (result.fusionTrace) {
        openaiResponse["fusion_trace"] = result.fusionTrace;
      }

      // Pass real usage data to recordRequestFinish for proper cost tracking
      const usage = result.usage;
      const responseUsage = openaiResponse["usage"] as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      recordRequestFinish({
        requestId,
        responseStatus: 200,
        responseTimeMs,
        promptTokens: usage?.promptTokens ?? responseUsage?.prompt_tokens,
        completionTokens: usage?.completionTokens ?? responseUsage?.completion_tokens,
        totalTokens: usage?.totalTokens ?? responseUsage?.total_tokens,
        cacheReadTokens: result.cacheHit === true ? (usage?.promptTokens ?? responseUsage?.prompt_tokens ?? 0) : undefined,
        cachedTokens: result.cacheHit === true ? (usage?.promptTokens ?? responseUsage?.prompt_tokens ?? 0) : undefined,
        resolvedModel: result.fusedByModelRouting || logicalModel,
        resolvedProvider: "fusion",
        responseBody: openaiResponse,
      });

      // Emit request.finished with fusionTrace for observability page
      const finishEvent: Record<string, unknown> = {
        type: "request.finished",
        at: nowIso(),
        status: 200,
        totalMs: responseTimeMs,
      };
      if (result.fusionTrace) {
        finishEvent["fusionTrace"] = result.fusionTrace;
      }
      emit(finishEvent as any);

      return c.json(openaiResponse);
    } catch (err) {
      const startedAt = c.get("startedAt") as number;
      const responseTimeMs = Math.round(performance.now() - startedAt);
      const message = err instanceof Error ? err.message : String(err);

      emit({
        type: "route.failed",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: logicalModel,
        errorType: "FusionError",
        message,
        willFallback: false,
      });

      recordRequestFinish({
        requestId,
        responseStatus: 500,
        responseTimeMs,
        errorMessage: message,
        resolvedModel: logicalModel,
        resolvedProvider: "fusion",
        responseBody: formatOpenAIError(500, `Fusion error: ${message}`, "internal_server_error"),
      });

      emit({
        type: "request.finished",
        at: nowIso(),
        status: 500,
        totalMs: responseTimeMs,
        errorType: message,
      });

      return c.json(
        formatOpenAIError(500, `Fusion error: ${message}`, "internal_server_error"),
        500,
      );
    }
  }

/**
 * Handle a streaming fusion request — streams SSE events for reasoning
 * summaries and the final fusion model output.
 * Now properly wired into the observability event sink.
 */
async function handleFusionStream(
  c: Context,
  fusionRouter: FusionRouter,
  fusionCtx: FusionRequestContext,
  requestId: string,
): Promise<Response> {
  const startedAt: number = c.get("startedAt");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      // If the client disconnects, controller.enqueue throws. Every write goes
      // through this guard so a mid-stream disconnect can never skip the
      // request-finish accounting below (a leaked inflight record blocks
      // graceful drains until the stale sweep).
      let clientGone = false;
      const safeEnqueue = (text: string): boolean => {
        if (clientGone) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          clientGone = true;
          return false;
        }
      };

      // SSE heartbeats: the fusion pipeline can be quiet for long stretches
      // (task division, subagent execution, provider queueing). Comment
      // lines keep the connection alive through proxies and idle timeouts;
      // OpenAI-compatible clients ignore them.
      let lastWrite = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastWrite < 5_000) return;
        if (safeEnqueue(": keep-alive\n\n")) {
          lastWrite = Date.now();
        } else {
          clearInterval(heartbeat);
        }
      }, 2_500);

      try {
        const generator = fusionRouter.stream(fusionCtx);
        for await (const event of generator) {
          if (event.trim() === "data: [DONE]") {
            continue;
          }
          if (!safeEnqueue(event)) break;
          lastWrite = Date.now();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeEnqueue(`data: ${JSON.stringify({ error: message })}\n\n`);
      } finally {
        clearInterval(heartbeat);
        safeEnqueue("data: [DONE]\n\n");
        try {
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to close
        }
      }

      const responseTimeMs = Math.round(performance.now() - startedAt);

      // Stream started event
      emit({
        type: "route.attempted",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: "fusion-stream",
        wireProtocol: "openai",
        isFallback: false,
        keyHint: "fusion",
      });

      // Emit stream finished as route.succeeded — must use latencyMs not durationMs
      emit({
        type: "route.succeeded",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: "fusion-stream",
        latencyMs: responseTimeMs,
      });

      recordRequestFinish({
        requestId,
        responseStatus: 200,
        responseTimeMs,
        resolvedModel: "fusion-stream",
        resolvedProvider: "fusion",
      });

      // Attach the compact fusion trace assembled by the streaming pipeline so
      // the observability page retains the completed pipeline state.
      const streamFinishEvent: Record<string, unknown> = {
        type: "request.finished",
        at: nowIso(),
        status: 200,
        totalMs: responseTimeMs,
      };
      if (fusionCtx.streamFusionTrace !== undefined) {
        streamFinishEvent["fusionTrace"] = fusionCtx.streamFusionTrace;
      }
      emit(streamFinishEvent as never);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
