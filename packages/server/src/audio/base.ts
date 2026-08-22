import type {
  AudioCapabilities,
  ResolvedAudioRoute,
} from "@model-proxy/contracts/schemas/audio-routing.ts";
import type {
  AudioResponseFormat,
  AudioTranscriptionRequest,
} from "@model-proxy/contracts/schemas/audio-wire.ts";

export interface AudioProviderCallContext {
  route: ResolvedAudioRoute;
  request: AudioTranscriptionRequest;
  formData: FormData;
  file: File | Blob | undefined;
  signal: AbortSignal | undefined;
}

export interface AudioProviderResponse {
  body: ConstructorParameters<typeof Response>[0];
  status: number;
  headers: Headers;
  streaming: boolean;
}

export interface AudioProviderAdapter {
  readonly format: ResolvedAudioRoute["format"];
  transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse>;
}

export class AudioProviderCapabilityError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "AudioProviderCapabilityError";
  }
}

export class AudioProviderUpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly body: string,
  ) {
    super(message);
    this.name = "AudioProviderUpstreamError";
  }
}

export function requireAudioCapabilities(
  capabilities: AudioCapabilities,
  request: AudioTranscriptionRequest,
): void {
  const format = request.response_format ?? "json";
  if (request.stream && capabilities.streaming === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support streaming transcription.",
    );
  }
  if (format === "text" && capabilities.text === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support text transcription responses.",
    );
  }
  if (format === "verbose_json" && capabilities.verbose_json === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support verbose_json transcription responses.",
    );
  }
  if (format === "srt" && capabilities.srt === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support SRT transcription responses.",
    );
  }
  if (format === "vtt" && capabilities.vtt === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support VTT transcription responses.",
    );
  }
  if (
    request.timestamp_granularities.length > 0 &&
    capabilities.timestamps === false
  ) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support timestamp granularities.",
    );
  }
  if (request.url !== undefined && capabilities.url_input === false) {
    throw new AudioProviderCapabilityError(
      "Selected audio route does not support URL audio input.",
    );
  }
}

export function audioContentType(format: AudioResponseFormat): string {
  if (format === "text") return "text/plain; charset=utf-8";
  if (format === "srt") return "application/x-subrip; charset=utf-8";
  if (format === "vtt") return "text/vtt; charset=utf-8";
  return "application/json; charset=utf-8";
}

export function mergeSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

