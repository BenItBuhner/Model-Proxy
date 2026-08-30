import { parsePositiveInt } from "../../shared/utils.ts";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { AnthropicMessagesRequest } from "@model-proxy/contracts/schemas/anthropic-wire.ts";
import { RoutingError, type ModelRoutingConfig } from "@model-proxy/contracts/schemas/routing.ts";
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
import {
  AccessDeniedError,
  assertCanUseLogicalModel,
} from "../../policy/access-control.ts";
import { reserveRequest } from "../../storage/limit-store.ts";
import { RouteExecutionError } from "../../providers/errors.ts";
import {
  EnforceRouter,
  EnforceValidationError,
} from "../../routing/enforce/index.ts";
import { FallbackRouter } from "../../routing/fallback.ts";
// Fusion is an optional module: only type imports are static; the runtime
// implementation is loaded lazily when a fusion-enabled model is requested.
import type { FusionRouter } from "../../routing/fusion/fusion-router.ts";
import type { FusionRequestContext, FusionResult } from "../../routing/fusion/types.ts";
import {
  buildUpstreamExtraHeaders,
  completionPersistenceForRequest,
  fusionUsageFromTrace,
  shouldPersistCompletion,
} from "./route-helpers.ts";
import { principal, requireAuth } from "../auth.ts";
import { formatAnthropicError } from "../error-formatters.ts";
import {
  estimateRequestTokens,
  recordRequestAbort,
  recordRequestFinish,
  recordRequestProgress,
  recordRequestStart,
} from "../request-log.ts";

const log = createLogger("routes.anthropic");
const MAX_CAPTURED_STREAM_CHARS = parsePositiveInt(process.env.STREAM_CAPTURE_MAX_CHARS) ?? 250_000;
const STREAM_HEARTBEAT_MS = parsePositiveInt(process.env.STREAM_HEARTBEAT_MS) ?? 5_000;

function routingErrorStatus(err: RoutingError): ContentfulStatusCode {
  const statuses = err.errors
    .map((entry) => entry["status_code"])
    .filter((status): status is number => typeof status === "number");
  if (statuses.length > 0 && statuses.every((status) => status === 504)) return 504;
  return 503;
}


export function createAnthropicRoutes(): Hono {
  const app = new Hono();
  // Scope auth to the Anthropic-only path so this router does not gate
  // other sub-apps mounted at the same root.
  app.use("/v1/messages", requireAuth({ allowSession: true }));
  app.use("/v1/messages/*", requireAuth({ allowSession: true }));

  app.post("/v1/messages", async (c) => {
    const requestId = c.get("requestId");
    const startedAt = c.get("startedAt");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(formatAnthropicError(400, "Invalid JSON body"), 400);
    }

    const parsed = AnthropicMessagesRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        formatAnthropicError(400, `Invalid request: ${parsed.error.message}`),
        400,
      );
    }

    const request = parsed.data;
    const requestDict: Record<string, unknown> = { ...request };
    const isStream = Boolean(requestDict["stream"]);
    const p = principal(c);
    const estimatedPromptTokens = estimateRequestTokens(requestDict);
    try {
      assertCanUseLogicalModel(p, request.model);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return c.json(formatAnthropicError(404, `Model '${request.model}' not found`), 404);
      }
      throw err;
    }
    const limitDecision = reserveRequest(p, estimatedPromptTokens ?? 0);
    if (!limitDecision.allowed) {
      return c.json(formatAnthropicError(429, limitDecision.reason ?? "Rate limit exceeded"), 429);
    }

    let modelConfig: ModelRoutingConfig;
    try {
      modelConfig = modelConfigLoader.loadConfig(request.model);
    } catch (err) {
      if (
        err instanceof ConfigNotFoundError ||
        err instanceof ConfigParseError ||
        err instanceof ConfigValidationError
      ) {
        return c.json(
          formatAnthropicError(
            400,
            `Model '${request.model}' not found in routing configuration.`,
          ),
          400,
        );
      }
      throw err;
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
      endpoint: "/v1/messages",
      method: "POST",
      requestedModel: request.model,
      resolvedModel: request.model,
      wireProtocol: "anthropic",
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
    const captureStreamPayload = shouldPersistCompletion(persistCompletions);
    if (modelConfig.fusion?.enabled === true) {
      return handleAnthropicFusionRequest({
        c,
        requestId,
        startedAt,
        requestDict,
        logicalModel: request.model,
        modelConfig,
        isStream,
        signal,
        principalValue: p,
      });
    }

    if (isStream) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          // If the client disconnects, controller.enqueue throws. Every write
          // goes through this guard so a mid-stream disconnect can never skip
          // the request-finish accounting below.
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
          const enqueueHeartbeat = () => {
            safeEnqueue(`: keep-alive ${Date.now()}\n\n`);
          };
          // Flush immediately so Cloudflare sees response bytes while slow
          // upstreams are still processing the prompt or cycling fallbacks.
          enqueueHeartbeat();
          const heartbeat = setInterval(enqueueHeartbeat, STREAM_HEARTBEAT_MS);
          try {
            await runWithRequestContext(requestId, async () => {
              emit({
                type: "request.started",
                at: nowIso(),
                protocol: "anthropic",
                endpoint: "/v1/messages",
                model: request.model,
                stream: true,
                enforceEnabled: enforceConfig.enabled,
              });
              try {
                const streamUsage = new StreamUsageTracker("anthropic", {
                  captureText: captureStreamPayload,
                  maxCapturedChars: MAX_CAPTURED_STREAM_CHARS,
                });
                const generator = enforceConfig.enabled
                  ? enforce.stream({
                      logicalModel: request.model,
                      requestData: requestDict,
                      targetProtocol: "anthropic",
                      overrides,
                      ...(p !== undefined ? { principal: p } : {}),
                      ...(signal !== undefined ? { signal } : {}),
                    })
                  : fallback.streamWithFallback({
                      logicalModel: request.model,
                      requestData: requestDict,
                      targetProtocol: "anthropic",
                      ...(p !== undefined ? { principal: p } : {}),
                      ...(signal !== undefined ? { signal } : {}),
                    });
                for await (const chunk of generator) {
                  streamUsage.ingest(chunk);
                  if (!safeEnqueue(chunk)) break;
                  recordRequestProgress({
                    requestId,
                    streamBytes: encoder.encode(chunk).byteLength,
                    streamChunkCount: 1,
                  });
                }
                try {
                  controller.close();
                } catch {
                  // stream already errored/cancelled
                }
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
                const status = err instanceof RoutingError ? routingErrorStatus(err) : 500;
                const message =
                  err instanceof Error ? err.message : `Streaming error: ${String(err)}`;
                const errorPayload = formatAnthropicError(status, message);
                safeEnqueue(`data: ${JSON.stringify(errorPayload)}\n\n`);
                try {
                  controller.close();
                } catch {
                  // stream already errored/cancelled
                }
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
            clearInterval(heartbeat);
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
        protocol: "anthropic",
        endpoint: "/v1/messages",
        model: request.model,
        stream: false,
        enforceEnabled: enforceConfig.enabled,
      });
      try {
        const response = enforceConfig.enabled
          ? await enforce.call({
              logicalModel: request.model,
              requestData: requestDict,
              targetProtocol: "anthropic",
              overrides,
              ...(p !== undefined ? { principal: p } : {}),
              ...(signal !== undefined ? { signal } : {}),
            })
          : await fallback.callWithFallback({
              logicalModel: request.model,
              requestData: requestDict,
              targetProtocol: "anthropic",
              ...(p !== undefined ? { principal: p } : {}),
              ...(signal !== undefined ? { signal } : {}),
            });
        const responseObj: Record<string, unknown> = {
          ...response,
          model: request.model,
        };
        const totalMs = Math.round(performance.now() - startedAt);
        recordRequestFinish({
          requestId,
          responseStatus: 200,
          responseTimeMs: totalMs,
          responseBody: responseObj,
        });
        emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });
        return c.json(responseObj);
      } catch (err) {
        const totalMs = Math.round(performance.now() - startedAt);
        if (err instanceof RoutingError) {
          const message = `All routes failed for model '${request.model}': ${err.summary()}`;
          const status = routingErrorStatus(err);
          recordRequestFinish({
            requestId,
            responseStatus: status,
            responseTimeMs: totalMs,
            errorMessage: message,
            errorType: err.name,
            responseBody: formatAnthropicError(status, message),
          });
          emit({
            type: "request.finished",
            at: nowIso(),
            status,
            totalMs,
            errorType: err.name,
            errorMessage: message,
          });
          return c.json(formatAnthropicError(status, message), status);
        }
        if (err instanceof RouteExecutionError) {
          const status = (err.statusCode ?? 502) as ContentfulStatusCode;
          recordRequestFinish({
            requestId,
            responseStatus: status,
            responseTimeMs: totalMs,
            errorMessage: err.message,
            errorType: err.name,
            responseBody: formatAnthropicError(status, err.message),
          });
          emit({
            type: "request.finished",
            at: nowIso(),
            status,
            totalMs,
            errorType: err.name,
            errorMessage: err.message,
          });
          return c.json(formatAnthropicError(status, err.message), status);
        }
        if (err instanceof EnforceValidationError) {
          const message = `Enforce tool-call validation failed after ${err.attempts} attempts: ${err.lastReason}`;
          recordRequestFinish({
            requestId,
            responseStatus: 502,
            responseTimeMs: totalMs,
            errorMessage: message,
            errorType: err.name,
            responseBody: formatAnthropicError(502, message),
          });
          emit({
            type: "request.finished",
            at: nowIso(),
            status: 502,
            totalMs,
            errorType: err.name,
            errorMessage: message,
          });
          return c.json(formatAnthropicError(502, message), 502);
        }
        log.error("unexpected error in /v1/messages", { err });
        const message = err instanceof Error ? err.message : String(err);
        const errType = err instanceof Error ? err.name : "Unknown";
        recordRequestFinish({
          requestId,
          responseStatus: 500,
          responseTimeMs: totalMs,
          errorMessage: message,
          errorType: errType,
          responseBody: formatAnthropicError(500, `Error processing request: ${message}`),
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
          formatAnthropicError(500, `Error processing request: ${message}`),
          500,
        );
      }
    });
  });

  return app;
}

async function handleAnthropicFusionRequest({
  c,
  requestId,
  startedAt,
  requestDict,
  logicalModel,
  modelConfig,
  isStream,
  signal,
  principalValue,
}: {
  c: Context;
  requestId: string;
  startedAt: number;
  requestDict: Record<string, unknown>;
  logicalModel: string;
  modelConfig: ModelRoutingConfig;
  isStream: boolean;
  signal: AbortSignal;
  principalValue: ReturnType<typeof principal>;
}): Promise<Response> {
  const fusionConfig = modelConfig.fusion;
  if (!fusionConfig?.enabled) {
    return c.json(formatAnthropicError(400, "Fusion not enabled for this model"), 400);
  }
  const { getSharedFusionRouter } = await import("../../routing/fusion/fusion-router.ts");
  const fusionRouter = getSharedFusionRouter();
  const messages = (requestDict["messages"] as unknown[]) ?? [];
  const fusionCtx: FusionRequestContext = {
    logicalModel,
    fusionConfig: {
      ...fusionConfig,
      fusion: { ...fusionConfig.fusion, wire_protocol: "anthropic" },
    },
    requestData: requestDict,
    clientProtocol: "anthropic",
    messages,
    signal,
    requestId,
    extraHeaders: buildUpstreamExtraHeaders(c),
    ...(principalValue !== undefined ? { principal: principalValue } : {}),
  };

  return runWithRequestContext(requestId, async () => {
    emit({
      type: "request.started",
      at: nowIso(),
      protocol: "anthropic",
      endpoint: "/v1/messages",
      model: logicalModel,
      stream: isStream,
      enforceEnabled: false,
    });
    try {
      if (isStream) {
        return handleAnthropicFusionStream(fusionRouter, fusionCtx, requestId, startedAt);
      }

      const result = await fusionRouter.route(fusionCtx);
      const response = anthropicFusionResponse(requestId, logicalModel, result);
      const totalMs = Math.round(performance.now() - startedAt);
      recordRequestFinish({
        requestId,
        responseStatus: 200,
        responseTimeMs: totalMs,
        responseBody: response,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
        cacheReadTokens: result.cacheHit === true ? (result.usage?.promptTokens ?? 0) : undefined,
        cachedTokens: result.cacheHit === true ? (result.usage?.promptTokens ?? 0) : undefined,
        resolvedProvider: "fusion",
        resolvedModel: result.fusedByModelRouting,
      });
      emit({ type: "request.finished", at: nowIso(), status: 200, totalMs, fusionTrace: result.fusionTrace } as any);
      return c.json(response);
    } catch (err) {
      const totalMs = Math.round(performance.now() - startedAt);
      const message = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof Error ? err.name : "FusionError";
      const errorPayload = formatAnthropicError(500, `Fusion error: ${message}`);
      recordRequestFinish({
        requestId,
        responseStatus: 500,
        responseTimeMs: totalMs,
        errorMessage: message,
        errorType,
        responseBody: errorPayload,
      });
      emit({ type: "request.finished", at: nowIso(), status: 500, totalMs, errorType, errorMessage: message });
      return c.json(errorPayload, 500);
    }
  });
}

function handleAnthropicFusionStream(
  fusionRouter: FusionRouter,
  fusionCtx: FusionRequestContext,
  requestId: string,
  startedAt: number,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let clientGone = false;
      let lastWrite = Date.now();
      const safeEnqueue = (text: string): boolean => {
        if (clientGone) return false;
        try {
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
          return true;
        } catch {
          clientGone = true;
          return false;
        }
      };

      const heartbeat = setInterval(() => {
        if (Date.now() - lastWrite < STREAM_HEARTBEAT_MS) return;
        if (!safeEnqueue(`: keep-alive ${Date.now()}\n\n`)) clearInterval(heartbeat);
      }, Math.max(1_000, Math.floor(STREAM_HEARTBEAT_MS / 2)));

      let status = 200;
      try {
        for await (const event of fusionRouter.stream(fusionCtx)) {
          if (!safeEnqueue(event)) break;
        }
      } catch (err) {
        status = 500;
        const message = err instanceof Error ? err.message : String(err);
        const payload = { type: "error", error: { type: "api_error", message: `Fusion error: ${message}` } };
        safeEnqueue(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // stream already errored/cancelled
        }
      }

      const totalMs = Math.round(performance.now() - startedAt);
      emit({
        type: "route.attempted",
        at: nowIso(),
        attempt: 1,
        provider: "fusion",
        model: "fusion-stream",
        wireProtocol: "anthropic",
        isFallback: false,
        keyHint: "fusion",
      });
      if (status === 200) {
        emit({
          type: "route.succeeded",
          at: nowIso(),
          attempt: 1,
          provider: "fusion",
          model: "fusion-stream",
          latencyMs: totalMs,
        });
      }
      const fusionUsage = status === 200 ? fusionUsageFromTrace(fusionCtx.streamFusionTrace) : undefined;
      recordRequestFinish({
        requestId,
        responseStatus: status,
        responseTimeMs: totalMs,
        resolvedModel: "fusion-stream",
        resolvedProvider: "fusion",
        ...(fusionUsage !== undefined
          ? {
              promptTokens: fusionUsage.promptTokens,
              completionTokens: fusionUsage.completionTokens,
              totalTokens: fusionUsage.totalTokens,
              promptTokensEstimated: true,
              completionTokensEstimated: true,
            }
          : {}),
      });
      const finishEvent: Record<string, unknown> = {
        type: "request.finished",
        at: nowIso(),
        status,
        totalMs,
      };
      if (fusionCtx.streamFusionTrace !== undefined) {
        finishEvent["fusionTrace"] = fusionCtx.streamFusionTrace;
      }
      emit(finishEvent as never);
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

function anthropicFusionResponse(
  requestId: string,
  logicalModel: string,
  result: FusionResult,
): Record<string, unknown> {
  const text = result.content ?? "";
  const contentBlocks: Array<Record<string, unknown>> = [];
  if (text.length > 0 || !result.toolCalls || result.toolCalls.length === 0) {
    contentBlocks.push({ type: "text", text });
  }

  // Map OpenAI-style tool_calls to proper Anthropic tool_use blocks instead
  // of dropping them into a lone text block.
  let hasToolUse = false;
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i] as Record<string, unknown>;
      if (tc?.["type"] === "tool_use") {
        contentBlocks.push(tc);
        hasToolUse = true;
        continue;
      }
      const fn = tc?.["function"] as Record<string, unknown> | undefined;
      const name = typeof fn?.["name"] === "string" ? (fn["name"] as string) : undefined;
      if (name === undefined) continue;
      let input: unknown = {};
      try {
        input = JSON.parse(String(fn?.["arguments"] ?? "{}"));
      } catch { /* leave empty input for malformed arguments */ }
      contentBlocks.push({
        type: "tool_use",
        id: String(tc["id"] ?? `toolu-${requestId}-${i}`),
        name,
        input,
      });
      hasToolUse = true;
    }
  }

  const response: Record<string, unknown> = {
    id: `msg-${requestId}`,
    type: "message",
    role: "assistant",
    model: logicalModel,
    content: contentBlocks,
    stop_reason: hasToolUse ? "tool_use" : (result.finishReason ?? "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.promptTokens ?? 0,
      output_tokens: result.usage?.completionTokens ?? Math.ceil(text.length / 4),
    },
  };
  if (result.reasoningContent !== undefined || result.reasoning !== undefined) {
    response["thinking"] = result.reasoningContent ?? result.reasoning;
  }
  if (result.fusionTrace !== undefined) response["fusion_trace"] = result.fusionTrace;
  return response;
}
