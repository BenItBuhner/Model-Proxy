import { providerConfigLoader } from "../config/provider-loader.ts";
import { buildAuthHeaders, buildEndpointUrl } from "../providers/provider-helpers.ts";
import {
  audioContentType,
  type AudioProviderAdapter,
  type AudioProviderCallContext,
  type AudioProviderResponse,
  AudioProviderCapabilityError,
  AudioProviderUpstreamError,
  mergeSignals,
  requireAudioCapabilities,
} from "./base.ts";
import { normalizeAudioJsonResponse } from "./normalize-response.ts";

export class NvidiaNimHttpAudioProvider implements AudioProviderAdapter {
  readonly format = "nvidia_nim_http" as const;

  async transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse> {
    requireAudioCapabilities(ctx.route.capabilities, ctx.request);
    const format = ctx.request.response_format ?? "json";
    if (ctx.request.stream) {
      throw new AudioProviderCapabilityError(
        "NVIDIA NIM HTTP transcription does not support SSE streaming.",
      );
    }
    if (format !== "json" && format !== "verbose_json") {
      throw new AudioProviderCapabilityError(
        `NVIDIA NIM HTTP transcription does not support response_format=${format}.`,
      );
    }

    const providerConfig = providerConfigLoader.loadProvider(ctx.route.provider);
    const url = buildEndpointUrl(
      providerConfig,
      ctx.route.baseUrl,
      "audio_transcriptions",
    );
    const outbound = new FormData();
    const file = ctx.file ?? ctx.formData.get("file");
    if (file instanceof Blob) outbound.set("file", file);
    outbound.set(
      "language",
      ctx.request.language ?? ctx.route.languageDefault ?? "en-US",
    );
    if (ctx.request.prompt !== undefined) outbound.set("prompt", ctx.request.prompt);
    if (ctx.request.temperature !== undefined) {
      outbound.set("temperature", String(ctx.request.temperature));
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, ctx.route.timeoutSeconds) * 1000,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildAuthHeaders(providerConfig, ctx.route.apiKey),
        body: outbound,
        signal: mergeSignals(ctx.signal, controller.signal),
      });

      const bodyText = await response.text();
      if (response.status >= 400) {
        throw new AudioProviderUpstreamError(
          `${ctx.route.provider} audio API error ${response.status}: ${bodyText.slice(0, 500)}`,
          response.status,
          response.status === 429 || response.status >= 500,
          bodyText,
        );
      }

      return {
        body: JSON.stringify(
          normalizeAudioJsonResponse(normalizeNimResponse(bodyText), format),
        ),
        status: response.status,
        headers: new Headers({ "content-type": audioContentType(format) }),
        streaming: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeNimResponse(bodyText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { text: bodyText };
  }
  if (typeof parsed === "string") return { text: parsed };
  if (parsed === null || typeof parsed !== "object") return { text: String(parsed) };
  const record = parsed as Record<string, unknown>;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.transcript === "string"
        ? record.transcript
        : typeof record.transcription === "string"
          ? record.transcription
          : "";
  return { ...record, text };
}

