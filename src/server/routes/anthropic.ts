import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { AnthropicMessagesRequest } from "../../../shared/schemas/anthropic-wire.ts";
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
import { FallbackRouter } from "../../routing/fallback.ts";
import { requireAuth } from "../auth.ts";
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

function extractAnthropicStreamUsage(text: string): Parameters<typeof recordRequestFinish>[0]["usage"] {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  for (const event of streamJsonPayloads(text)) {
    const usage = event["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const usageObj = usage as Record<string, unknown>;
    inputTokens = numberField(usageObj, "input_tokens") ?? inputTokens;
    outputTokens = numberField(usageObj, "output_tokens") ?? outputTokens;
    cacheReadTokens = numberField(usageObj, "cache_read_input_tokens") ?? cacheReadTokens;
    cacheCreationTokens = numberField(usageObj, "cache_creation_input_tokens") ?? cacheCreationTokens;
  }
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
    cacheReadTokens,
    cacheCreationTokens,
    cachedTokens: cacheReadTokens,
  };
}

function extractAnthropicStreamOutputTokens(text: string, fallbackCharCount?: number): number | undefined {
  const usage = extractAnthropicStreamUsage(text);
  if (usage?.completionTokens !== undefined) return usage.completionTokens;
  if (fallbackCharCount !== undefined && Number.isFinite(fallbackCharCount)) {
    return Math.ceil(fallbackCharCount / 4);
  }
  return estimateRequestTokens(text);
}

function streamJsonPayloads(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // Ignore non-JSON stream frames.
    }
  }
  return out;
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
                let responseText = "";
                let responseChars = 0;
                const generator = enforceConfig.enabled
                  ? enforce.stream({
                      logicalModel: request.model,
                      requestData: requestDict,
                      targetProtocol: "anthropic",
                      overrides,
                      ...(signal !== undefined ? { signal } : {}),
                    })
                  : fallback.streamWithFallback({
                      logicalModel: request.model,
                      requestData: requestDict,
                      targetProtocol: "anthropic",
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
                  completionTokens: extractAnthropicStreamOutputTokens(responseText, responseChars),
                  completionTokensEstimated: extractAnthropicStreamUsage(responseText) === undefined,
                  usage: extractAnthropicStreamUsage(responseText),
                });
              } catch (err) {
                const status = err instanceof RoutingError ? routingErrorStatus(err) : 500;
                const message =
                  err instanceof Error ? err.message : `Streaming error: ${String(err)}`;
                const errorPayload = formatAnthropicError(status, message);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
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
              ...(signal !== undefined ? { signal } : {}),
            })
          : await fallback.callWithFallback({
              logicalModel: request.model,
              requestData: requestDict,
              targetProtocol: "anthropic",
              ...(signal !== undefined ? { signal } : {}),
            });
        const responseObj: Record<string, unknown> = {
          ...response,
          model: request.model,
        };
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
        const input = usageObj["input_tokens"];
        const output = usageObj["output_tokens"];
        if (typeof input === "number") finish.promptTokens = input;
        if (typeof output === "number") finish.completionTokens = output;
        if (typeof input === "number" && typeof output === "number") {
          finish.totalTokens = input + output;
        }
        recordRequestFinish(finish);
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
