import type { Context } from "hono";
import { Hono } from "hono";

import {
  AudioRoutingError,
} from "../../../shared/schemas/audio-routing.ts";
import {
  AudioTranscriptionRequestSchema,
} from "../../../shared/schemas/audio-wire.ts";
import {
  AudioConfigNotFoundError,
  AudioConfigParseError,
  AudioConfigValidationError,
  audioModelConfigLoader,
} from "../../config/audio-model-loader.ts";
import { AudioFallbackRouter } from "../../audio/fallback.ts";
import {
  AudioProviderCapabilityError,
} from "../../audio/base.ts";
import {
  emit,
  nowIso,
  runWithRequestContext,
} from "../../observability/request-context.ts";
import {
  AccessDeniedError,
  assertCanUseAudioModel,
  canUseAudioModel,
} from "../../policy/access-control.ts";
import { reserveRequest } from "../../storage/limit-store.ts";
import {
  recordRequestAbort,
  recordRequestFinish,
  recordRequestStart,
} from "../request-log.ts";
import { principal, requireAuth } from "../auth.ts";

export function createAudioRoutes(): Hono {
  const app = new Hono();
  app.use("/v1/audio/*", requireAuth({ allowSession: true }));

  app.get("/v1/audio/models", (c) => {
    const p = principal(c);
    const data = audioModelConfigLoader.getAvailableModels().filter((id) => canUseAudioModel(p, id)).map((id) => ({
      id,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: "audio",
    }));
    return c.json({ object: "list", data });
  });

  app.post("/v1/audio/transcriptions", (c) =>
    handleTranscription(c, "/v1/audio/transcriptions"),
  );

  return app;
}

async function handleTranscription(
  c: Context,
  endpointPath: string,
): Promise<Response> {
  const requestId = c.get("requestId");
  const startedAt = c.get("startedAt");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(audioError("Invalid multipart/form-data body", "invalid_request_error"), 400);
  }

  const file = formData.get("file");
  const url = stringValue(formData.get("url"));
  if (!(file instanceof Blob) && url === undefined) {
    return c.json(
      audioError("Audio transcription requires a multipart file or url field.", "invalid_request_error"),
      400,
    );
  }

  const metadata = formDataToMetadata(formData);
  const parsed = AudioTranscriptionRequestSchema.safeParse(metadata);
  if (!parsed.success) {
    return c.json(
      audioError(`Invalid request: ${parsed.error.message}`, "invalid_request_error"),
      400,
    );
  }
  const request = parsed.data;
  const isStream = request.stream === true;
  const p = principal(c);
  try {
    assertCanUseAudioModel(p, request.model);
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      return c.json(audioError(`Audio model '${request.model}' not found`, "invalid_request_error"), 404);
    }
    throw err;
  }
  const limitDecision = reserveRequest(p);
  if (!limitDecision.allowed) {
    return c.json(audioError(limitDecision.reason ?? "Rate limit exceeded", "rate_limit_exceeded"), 429);
  }

  try {
    audioModelConfigLoader.loadConfig(request.model);
  } catch (err) {
    if (
      err instanceof AudioConfigNotFoundError ||
      err instanceof AudioConfigParseError ||
      err instanceof AudioConfigValidationError
    ) {
      const available = audioModelConfigLoader.getAvailableModels().join(", ") || "(none)";
      return c.json(
        audioError(
          `Audio model '${request.model}' not found in routing configuration. Available audio models: ${available}`,
          "invalid_request_error",
        ),
        400,
      );
    }
    throw err;
  }

  recordRequestStart({
    requestId,
    endpoint: endpointPath,
    method: "POST",
    requestedModel: request.model,
    resolvedModel: request.model,
    wireProtocol: "audio",
    isStreaming: isStream,
    enforceMode: false,
    requestBody: {
      ...metadata,
      file:
        file instanceof Blob
          ? { name: "name" in file ? String((file as { name?: unknown }).name) : undefined, size: file.size, type: file.type }
          : undefined,
    },
    userId: p?.userId,
    apiKeyId: p?.apiKeyId,
    principalRole: p?.role,
    ownerBypass: p?.ownerBypass,
  });
  const recordAbort = () => {
    recordRequestAbort({
      requestId,
      responseTimeMs: Math.round(performance.now() - startedAt),
    });
  };
  if (c.req.raw.signal.aborted) {
    recordAbort();
  } else {
    c.req.raw.signal.addEventListener("abort", recordAbort, { once: true });
  }

  const run = async (): Promise<Response> =>
    runWithRequestContext(requestId, async () => {
      emit({
        type: "request.started",
        at: nowIso(),
        protocol: "audio",
        endpoint: endpointPath,
        model: request.model,
        stream: isStream,
        enforceEnabled: false,
      });
      try {
        const router = new AudioFallbackRouter();
        const response = await router.transcribeWithFallback({
          logicalModel: request.model,
          request,
          formData,
          file: file instanceof Blob ? file : undefined,
          signal: c.req.raw.signal,
        });
        const responseForStorage = new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
        const responseBytes = await responseForStorage.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("json") || contentType.startsWith("text/")
          ? new TextDecoder().decode(responseBytes)
          : { binary: true, bytes: responseBytes.byteLength, contentType };
        const totalMs = Math.round(performance.now() - startedAt);
        emit({ type: "request.finished", at: nowIso(), status: response.status, totalMs });
        recordRequestFinish({
          requestId,
          responseStatus: response.status,
          responseTimeMs: totalMs,
          responseBody,
        });
        return new Response(responseBytes, {
          status: response.status,
          headers: response.headers,
        });
      } catch (err) {
        const status = statusForAudioError(err);
        const message = err instanceof Error ? err.message : String(err);
        const type =
          status === 422
            ? "unsupported_audio_feature"
            : status === 503
              ? "service_unavailable"
              : "invalid_request_error";
        const totalMs = Math.round(performance.now() - startedAt);
        emit({
          type: "request.finished",
          at: nowIso(),
          status,
          totalMs,
          errorType: err instanceof Error ? err.name : "Unknown",
          errorMessage: message,
        });
        recordRequestFinish({
          requestId,
          responseStatus: status,
          responseTimeMs: totalMs,
          errorMessage: message,
          errorType: err instanceof Error ? err.name : "Unknown",
          responseBody: audioError(message, type),
        });
        return c.json(audioError(message, type), status);
      }
    });

  return run();
}

function formDataToMetadata(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "file") continue;
    if (key === "timestamp_granularities[]" || key === "timestamp_granularities") {
      const existing = out["timestamp_granularities"];
      const next = typeof value === "string" ? value : String(value);
      out["timestamp_granularities"] = Array.isArray(existing)
        ? [...existing, next]
        : [next];
      continue;
    }
    if (key === "include[]" || key === "include") {
      const existing = out["include"];
      const next = typeof value === "string" ? value : String(value);
      out["include"] = Array.isArray(existing) ? [...existing, next] : [next];
      continue;
    }
    if (key === "temperature") {
      out[key] = Number(value);
      continue;
    }
    if (key === "stream") {
      out[key] = value === "true" || value === "1" || value === "on";
      continue;
    }
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function statusForAudioError(err: unknown): 400 | 422 | 503 {
  if (err instanceof AudioProviderCapabilityError) return 422;
  if (err instanceof AudioRoutingError) return 503;
  return 400;
}

function audioError(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

