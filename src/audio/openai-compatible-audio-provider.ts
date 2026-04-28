import { providerConfigLoader } from "../config/provider-loader.ts";
import { buildAuthHeaders, buildEndpointUrl } from "../providers/provider-helpers.ts";
import {
  audioContentType,
  type AudioProviderAdapter,
  type AudioProviderCallContext,
  type AudioProviderResponse,
  AudioProviderUpstreamError,
  mergeSignals,
  requireAudioCapabilities,
} from "./base.ts";
import { normalizeAudioJsonResponse } from "./normalize-response.ts";

const FORWARDED_FIELDS = [
  "language",
  "prompt",
  "response_format",
  "temperature",
  "url",
  "chunking_strategy",
  "target_language",
  "task",
  "custom_configuration",
] as const;

export class OpenAICompatibleAudioProvider implements AudioProviderAdapter {
  readonly format = "openai_audio" as const;

  async transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse> {
    requireAudioCapabilities(ctx.route.capabilities, ctx.request);

    const providerConfig = providerConfigLoader.loadProvider(ctx.route.provider);
    const endpointType = ctx.request.stream ? "audio_streaming" : "audio_transcriptions";
    const url = buildEndpointUrl(providerConfig, ctx.route.baseUrl, endpointType);
    const outbound = new FormData();
    const file = ctx.file ?? ctx.formData.get("file");
    if (file instanceof Blob) outbound.set("file", file);
    if (ctx.request.url !== undefined) outbound.set("url", ctx.request.url);
    outbound.set("model", ctx.route.model);
    if (ctx.request.stream) outbound.set("stream", "true");

    for (const key of FORWARDED_FIELDS) {
      const value = ctx.request[key];
      if (value === undefined || key === "url") continue;
      if (typeof value === "boolean") outbound.set(key, value ? "true" : "false");
      else if (typeof value === "number") outbound.set(key, String(value));
      else if (typeof value === "string") {
        outbound.set(key, key === "language" ? normalizeLanguage(value) : value);
      }
      else outbound.set(key, JSON.stringify(value));
    }

    for (const granularity of ctx.request.timestamp_granularities) {
      outbound.append("timestamp_granularities[]", granularity);
    }
    for (const include of ctx.request.include) {
      outbound.append("include[]", include);
    }

    return fetchAudio(url, outbound, ctx, buildAuthHeaders(providerConfig, ctx.route.apiKey));
  }
}

async function fetchAudio(
  url: string,
  body: FormData,
  ctx: AudioProviderCallContext,
  authHeaders: Record<string, string>,
): Promise<AudioProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, ctx.route.timeoutSeconds) * 1000,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders,
      body,
      signal: mergeSignals(ctx.signal, controller.signal),
    });

    if (response.status >= 400) {
      const text = await response.text().catch(() => "");
      throw new AudioProviderUpstreamError(
        `${ctx.route.provider} audio API error ${response.status}: ${text.slice(0, 500)}`,
        response.status,
        response.status === 429 || response.status >= 500,
        text,
      );
    }

    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const format = ctx.request.response_format ?? "json";
    if (ctx.request.stream) {
      headers.set("content-type", "text/event-stream; charset=utf-8");
    } else if ((headers.get("content-type") ?? "").trim().length === 0) {
      headers.set("content-type", audioContentType(format));
    }
    if (
      !ctx.request.stream &&
      (format === "json" || format === "verbose_json") &&
      (headers.get("content-type") ?? "").includes("application/json")
    ) {
      const text = await response.text();
      return {
        body: JSON.stringify(normalizeAudioJsonResponse(text, format)),
        status: response.status,
        headers: new Headers({ "content-type": audioContentType(format) }),
        streaming: false,
      };
    }
    return {
      body: response.body,
      status: response.status,
      headers,
      streaming: ctx.request.stream,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLanguage(language: string): string {
  const trimmed = language.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.toLowerCase() === "multi") return "multi";
  return trimmed.split("-")[0]?.toLowerCase() ?? trimmed.toLowerCase();
}

