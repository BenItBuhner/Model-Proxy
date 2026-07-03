import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { OpenAIChatCompletionRequest } from "../../../shared/schemas/openai-wire.ts";
import { RoutingError, type ModelRoutingConfig } from "../../../shared/schemas/routing.ts";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  modelConfigLoader,
} from "../../config/model-loader.ts";
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

export function createOpenAIRoutes(): Hono {
  const app = new Hono();
  // Scope auth to OpenAI-only paths so this router does not gate
  // admin/auth/health endpoints when mounted at root.
  app.use("/v1/models", requireAuth({ allowSession: true }));
  app.use("/v1/chat/*", requireAuth({ allowSession: true }));

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

  return app;
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
