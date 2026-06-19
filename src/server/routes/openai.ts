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
import { FallbackRouter } from "../../routing/fallback.ts";
import { FusionRouter } from "../../routing/fusion/fusion-router.ts";
import type { FusionRequestContext } from "../../routing/fusion/types.ts";
import { requireAuth } from "../auth.ts";
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

function extractOpenAIStreamUsage(text: string): Parameters<typeof recordRequestFinish>[0]["usage"] {
  const usage = findLastStreamUsage(text);
  if (usage === undefined) return undefined;
  return {
    promptTokens: numberField(usage, "prompt_tokens"),
    completionTokens: numberField(usage, "completion_tokens"),
    totalTokens: numberField(usage, "total_tokens"),
  };
}

function extractOpenAIStreamCompletionTokens(text: string, fallbackCharCount?: number): number | undefined {
  const usage = extractOpenAIStreamUsage(text);
  if (usage?.completionTokens !== undefined) return usage.completionTokens;
  if (fallbackCharCount !== undefined && Number.isFinite(fallbackCharCount)) {
    return Math.ceil(fallbackCharCount / 4);
  }
  return estimateRequestTokens(text);
}

function findLastStreamUsage(text: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]" || payload === "") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed["usage"] === "object" && parsed["usage"] !== null) {
        last = parsed["usage"] as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON stream frames.
    }
  }
  return last;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function appendCapturedStream(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= MAX_CAPTURED_STREAM_CHARS) return combined;
  return combined.slice(-MAX_CAPTURED_STREAM_CHARS);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function createOpenAIRoutes(): Hono {
  const app = new Hono();
  // Scope auth to OpenAI-only paths so this router does not gate
  // admin/auth/health endpoints when mounted at root.
  app.use("/v1/models", requireAuth({ allowSession: true }));
  app.use("/v1/chat/*", requireAuth({ allowSession: true }));

  app.get("/v1/models", async (c) => {
    const models = modelConfigLoader.getAvailableModels();
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
    return handleFusionRequest(c, requestDict, request.model, modelConfig, isStream, endpointPath);
  }

  const fallback = new FallbackRouter();
  const enforce = new EnforceRouter(fallback);
  const overrides = {
    header: c.req.header("x-enforce-tool-call"),
    query: c.req.query("enforce_tool_call"),
  };
  const enforceConfig = enforce.resolveConfig({
    logicalModel: request.model,
    overrides,
  });

  recordRequestStart({
    requestId,
    endpoint: endpointPath,
    method: "POST",
    requestedModel: request.model,
    resolvedModel: request.model,
    wireProtocol: "openai",
    isStreaming: isStream,
    enforceMode: enforceConfig.enabled,
    promptTokens: estimateRequestTokens(requestDict),
    promptTokensEstimated: true,
    requestBody: requestDict,
    persistCompletions: modelConfig.persist_completions,
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
              let responseText = "";
              let responseChars = 0;
              const generator = enforceConfig.enabled
                ? enforce.stream({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "openai",
                    overrides,
                    extraHeaders,
                    ...(signal !== undefined ? { signal } : {}),
                  })
                : fallback.streamWithFallback({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "openai",
                    extraHeaders,
                    ...(signal !== undefined ? { signal } : {}),
                  });
              for await (const chunk of generator) {
                responseChars += chunk.length;
                responseText = appendCapturedStream(responseText, chunk);
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
              recordRequestFinish({
                requestId,
                responseStatus: 200,
                responseTimeMs: totalMs,
                responseBody: responseText,
                completionTokens: extractOpenAIStreamCompletionTokens(responseText, responseChars),
                completionTokensEstimated: findLastStreamUsage(responseText) === undefined,
                usage: extractOpenAIStreamUsage(responseText),
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
            ...(signal !== undefined ? { signal } : {}),
          })
        : await fallback.callWithFallback({
            logicalModel: request.model,
            requestData: requestDict,
            targetProtocol: "openai",
            extraHeaders,
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
  if (!fusionConfig?.enabled) {
    // Should not happen — guard from caller
    return c.json(
      formatOpenAIError(400, "Fusion not enabled for this model", "invalid_request_error"),
      400,
    );
  }

  const fusionRouter = new FusionRouter();
  const messages = (requestDict["messages"] as unknown[]) ?? [];

  const fusionCtx: FusionRequestContext = {
    logicalModel,
    fusionConfig,
    requestData: requestDict,
    clientProtocol: "openai",
    messages,
    signal: c.req.raw.signal,
  };

  // Record the fusion-specific request start
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
    persistCompletions: false,
  });

  if (isStream) {
    return handleFusionStream(c, fusionRouter, fusionCtx, requestId);
  }

  // Non-streaming path
  try {
    const startedAt = c.get("startedAt") as number;
    const result = await fusionRouter.route(fusionCtx);
    const responseTimeMs = Math.round(performance.now() - startedAt);

    // Build an OpenAI-compatible response
    const openaiResponse = {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: logicalModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.content,
          },
          finish_reason: "stop",
        },
      ],
      usage: result.usage ?? {
        prompt_tokens: estimateRequestTokens(requestDict) ?? 0,
        completion_tokens: Math.ceil(result.content.length / 4),
        total_tokens: (estimateRequestTokens(requestDict) ?? 0) + Math.ceil(result.content.length / 4),
      },
    };

    recordRequestFinish({
      requestId,
      responseStatus: 200,
      responseTimeMs,
      responseBody: openaiResponse,
    });

    emit({
      type: "request.finished",
      at: nowIso(),
      status: 200,
      totalMs: responseTimeMs,
    });

    return c.json(openaiResponse);
  } catch (err) {
    const startedAt = c.get("startedAt") as number;
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const message = err instanceof Error ? err.message : String(err);

    recordRequestFinish({
      requestId,
      responseStatus: 500,
      responseTimeMs,
      errorMessage: message,
      responseBody: formatOpenAIError(500, `Fusion error: ${message}`, "internal_server_error"),
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

      try {
        const generator = fusionRouter.stream(fusionCtx);
        for await (const event of generator) {
          controller.enqueue(encoder.encode(event));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`),
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }

      const responseTimeMs = Math.round(performance.now() - startedAt);
      recordRequestFinish({
        requestId,
        responseStatus: 200,
        responseTimeMs,
      });
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
