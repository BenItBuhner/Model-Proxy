import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { OpenAIChatCompletionRequest } from "../../../shared/schemas/openai-wire.ts";
import { RoutingError } from "../../../shared/schemas/routing.ts";
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
import { requireAuth } from "../auth.ts";
import { formatOpenAIError } from "../error-formatters.ts";
import {
  recordRequestFinish,
  recordRequestStart,
} from "../request-log.ts";

const log = createLogger("routes.openai");

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
  try {
    modelConfigLoader.loadConfig(request.model);
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
  });

  const signal = c.req.raw.signal;

  if (isStream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // Nested run() so async generator iteration (which happens lazily
        // here, after the outer request handler returned) still resolves
        // `currentEmitter()` correctly for every emit call deep in the stack.
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
            const generator = enforceConfig.enabled
              ? enforce.stream({
                  logicalModel: request.model,
                  requestData: requestDict,
                  targetProtocol: "openai",
                  overrides,
                  ...(signal !== undefined ? { signal } : {}),
                })
              : fallback.streamWithFallback({
                  logicalModel: request.model,
                  requestData: requestDict,
                  targetProtocol: "openai",
                  ...(signal !== undefined ? { signal } : {}),
                });
            for await (const chunk of generator) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
            const totalMs = Math.round(performance.now() - startedAt);
            emit({ type: "request.finished", at: nowIso(), status: 200, totalMs });
            recordRequestFinish({
              requestId,
              responseStatus: 200,
              responseTimeMs: totalMs,
            });
          } catch (err) {
            const status = err instanceof RoutingError ? 503 : 500;
            const type =
              err instanceof RoutingError ? "service_unavailable" : "internal_server_error";
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
            });
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
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
            ...(signal !== undefined ? { signal } : {}),
          })
        : await fallback.callWithFallback({
            logicalModel: request.model,
            requestData: requestDict,
            targetProtocol: "openai",
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
        recordRequestFinish({
          requestId,
          responseStatus: 503,
          responseTimeMs: totalMs,
          errorMessage: message,
          errorType: err.name,
        });
        emit({
          type: "request.finished",
          at: nowIso(),
          status: 503,
          totalMs,
          errorType: err.name,
          errorMessage: message,
        });
        return c.json(formatOpenAIError(503, message, "service_unavailable"), 503);
      }
      if (err instanceof RouteExecutionError) {
        const status = (err.statusCode ?? 502) as ContentfulStatusCode;
        recordRequestFinish({
          requestId,
          responseStatus: status,
          responseTimeMs: totalMs,
          errorMessage: err.message,
          errorType: err.name,
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
