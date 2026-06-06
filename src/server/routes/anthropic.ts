import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { AnthropicMessagesRequest } from "../../../shared/schemas/anthropic-wire.ts";
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
import { FallbackRouter } from "../../routing/fallback.ts";
import { requireAuth } from "../auth.ts";
import { formatAnthropicError } from "../error-formatters.ts";
import {
  recordRequestFinish,
  recordRequestStart,
  routeFinishFields,
  type FinishEntry,
} from "../request-log.ts";
import { buildUpstreamExtraHeaders } from "../upstream-headers.ts";

const log = createLogger("routes.anthropic");

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

    try {
      modelConfigLoader.loadConfig(request.model);
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
      endpoint: "/v1/messages",
      method: "POST",
      requestedModel: request.model,
      resolvedModel: request.model,
      wireProtocol: "anthropic",
      isStreaming: isStream,
      enforceMode: enforceConfig.enabled,
    });

    const signal = c.req.raw.signal;
    const extraHeaders = buildUpstreamExtraHeaders(c, requestId);
    const resolvedRoute: { provider?: string; model?: string } = {};

    if (isStream) {
      let finished = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const finishOnce = (entry: FinishEntry, eventStatus: number): void => {
            if (finished) return;
            finished = true;
            recordRequestFinish(entry);
            emit({
              type: "request.finished",
              at: nowIso(),
              status: eventStatus,
              totalMs: entry.responseTimeMs,
              ...(entry.errorType !== undefined ? { errorType: entry.errorType } : {}),
              ...(entry.errorMessage !== undefined ? { errorMessage: entry.errorMessage } : {}),
            });
          };
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
              const generator = enforceConfig.enabled
                ? enforce.stream({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "anthropic",
                    overrides,
                    extraHeaders,
                    resolvedRoute,
                    ...(signal !== undefined ? { signal } : {}),
                  })
                : fallback.streamWithFallback({
                    logicalModel: request.model,
                    requestData: requestDict,
                    targetProtocol: "anthropic",
                    extraHeaders,
                    resolvedRoute,
                    ...(signal !== undefined ? { signal } : {}),
                  });
              for await (const chunk of generator) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
              const totalMs = Math.round(performance.now() - startedAt);
              finishOnce(
                {
                  requestId,
                  responseStatus: 200,
                  responseTimeMs: totalMs,
                  ...routeFinishFields(resolvedRoute),
                },
                200,
              );
            } catch (err) {
              const status = err instanceof RoutingError ? 503 : 500;
              const message =
                err instanceof Error ? err.message : `Streaming error: ${String(err)}`;
              const errorPayload = formatAnthropicError(status, message);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
              controller.close();
              const totalMs = Math.round(performance.now() - startedAt);
              const errorType = err instanceof Error ? err.name : "Unknown";
              finishOnce(
                {
                  requestId,
                  responseStatus: status,
                  responseTimeMs: totalMs,
                  errorMessage: message,
                  errorType,
                  ...routeFinishFields(resolvedRoute),
                },
                status,
              );
            }
          });
        },
        cancel() {
          const totalMs = Math.round(performance.now() - startedAt);
          if (finished) return;
          finished = true;
          recordRequestFinish({
            requestId,
            responseStatus: 499,
            responseTimeMs: totalMs,
            errorMessage: "Client disconnected before stream completed",
            errorType: "ClientAbort",
            ...routeFinishFields(resolvedRoute),
          });
          emit({
            type: "request.finished",
            at: nowIso(),
            status: 499,
            totalMs,
            errorType: "ClientAbort",
            errorMessage: "Client disconnected before stream completed",
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
              extraHeaders,
              resolvedRoute,
              ...(signal !== undefined ? { signal } : {}),
            })
          : await fallback.callWithFallback({
              logicalModel: request.model,
              requestData: requestDict,
              targetProtocol: "anthropic",
              extraHeaders,
              resolvedRoute,
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
          ...routeFinishFields(resolvedRoute),
        });
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
            ...routeFinishFields(resolvedRoute),
          });
          emit({
            type: "request.finished",
            at: nowIso(),
            status: 503,
            totalMs,
            errorType: err.name,
            errorMessage: message,
          });
          return c.json(formatAnthropicError(503, message), 503);
        }
        if (err instanceof RouteExecutionError) {
          const status = (err.statusCode ?? 502) as ContentfulStatusCode;
          recordRequestFinish({
            requestId,
            responseStatus: status,
            responseTimeMs: totalMs,
            errorMessage: err.message,
            errorType: err.name,
            ...routeFinishFields(resolvedRoute),
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
            ...routeFinishFields(resolvedRoute),
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
          ...routeFinishFields(resolvedRoute),
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
