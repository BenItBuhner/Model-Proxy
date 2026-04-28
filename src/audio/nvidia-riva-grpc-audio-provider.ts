import { join } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { providerConfigLoader } from "../config/provider-loader.ts";
import { audioContentType, type AudioProviderAdapter, type AudioProviderCallContext, type AudioProviderResponse, AudioProviderCapabilityError, AudioProviderUpstreamError, requireAudioCapabilities } from "./base.ts";
import { normalizeAudioJsonResponse } from "./normalize-response.ts";

interface RivaRecognizeClient {
  Recognize(
    request: RivaRecognizeRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response?: RivaRecognizeResponse) => void,
  ): grpc.ClientUnaryCall;
  close(): void;
}

interface RivaRecognizeRequest {
  config: {
    encoding: "LINEAR_PCM" | "FLAC" | "OGGOPUS";
    sampleRateHertz: number;
    languageCode: string;
    maxAlternatives: number;
    audioChannelCount: number;
    enableAutomaticPunctuation: boolean;
    enableWordTimeOffsets: boolean;
    verbatimTranscripts: boolean;
    customConfiguration?: Record<string, string>;
  };
  audio: Buffer;
  id?: { id: string };
}

interface RivaRecognizeResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: Array<Record<string, unknown>>;
      languageCode?: string[];
    }>;
    audioProcessed?: number;
  }>;
}

let serviceCtor: grpc.ServiceClientConstructor | undefined;

export class NvidiaRivaGrpcAudioProvider implements AudioProviderAdapter {
  readonly format = "nvidia_riva_grpc" as const;

  async transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse> {
    requireAudioCapabilities(ctx.route.capabilities, ctx.request);
    const format = ctx.request.response_format ?? "json";
    if (ctx.request.stream) {
      throw new AudioProviderCapabilityError(
        "NVIDIA hosted Riva ASR route currently supports offline transcription only.",
      );
    }
    if (format !== "json" && format !== "verbose_json") {
      throw new AudioProviderCapabilityError(
        `NVIDIA hosted Riva ASR does not support response_format=${format}.`,
      );
    }
    if (ctx.route.functionId === undefined) {
      throw new AudioProviderCapabilityError(
        "NVIDIA hosted Riva ASR route is missing function_id.",
      );
    }

    const file = ctx.file ?? ctx.formData.get("file");
    if (!(file instanceof Blob)) {
      throw new AudioProviderCapabilityError("NVIDIA hosted Riva ASR requires a file.");
    }

    const providerConfig = providerConfigLoader.loadProvider(ctx.route.provider);
    const target = grpcTarget(ctx.route.baseUrl ?? providerConfig.endpoints.base_url);
    const client = new (getServiceCtor())(
      target,
      grpc.credentials.createSsl(),
    ) as unknown as RivaRecognizeClient;

    const metadata = new grpc.Metadata();
    metadata.set("function-id", ctx.route.functionId);
    metadata.set("authorization", `Bearer ${ctx.route.apiKey}`);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, ctx.route.timeoutSeconds) * 1000,
    );
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const request: RivaRecognizeRequest = {
        config: {
          encoding: inferEncoding(file),
          sampleRateHertz: 16000,
          languageCode: normalizeLanguageCode(
            ctx.request.language ?? ctx.route.languageDefault ?? "en-US",
            ctx.route.model,
          ),
          maxAlternatives: 1,
          audioChannelCount: 1,
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: ctx.request.timestamp_granularities.length > 0,
          verbatimTranscripts: false,
        },
        audio: Buffer.from(await file.arrayBuffer()),
      };

      const response = await recognize(client, request, metadata, {
        deadline: new Date(Date.now() + Math.max(1, ctx.route.timeoutSeconds) * 1000),
        signal: controller.signal,
      });
      return {
        body: JSON.stringify(normalizeAudioJsonResponse(normalizeRivaResponse(response), format)),
        status: 200,
        headers: new Headers({ "content-type": audioContentType(format) }),
        streaming: false,
      };
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
      client.close();
    }
  }
}

function getServiceCtor(): grpc.ServiceClientConstructor {
  if (serviceCtor !== undefined) return serviceCtor;
  const protoPath = join(import.meta.dir, "proto", "riva", "proto", "riva_asr.proto");
  const definition = protoLoader.loadSync(protoPath, {
    includeDirs: [join(import.meta.dir, "proto")],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as {
    nvidia?: { riva?: { asr?: { RivaSpeechRecognition?: grpc.ServiceClientConstructor } } };
  };
  const ctor = loaded.nvidia?.riva?.asr?.RivaSpeechRecognition;
  if (ctor === undefined) {
    throw new Error("Failed to load NVIDIA Riva ASR gRPC service definition.");
  }
  serviceCtor = ctor;
  return ctor;
}

function grpcTarget(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function inferEncoding(file: Blob): "LINEAR_PCM" | "FLAC" | "OGGOPUS" {
  const type = file.type.toLowerCase();
  if (type.includes("flac")) return "FLAC";
  if (type.includes("ogg") || type.includes("opus") || type.includes("webm")) {
    return "OGGOPUS";
  }
  return "LINEAR_PCM";
}

function normalizeLanguageCode(language: string, model: string): string {
  const trimmed = language.trim();
  if (trimmed.length === 0) return model.includes("whisper") ? "en" : "en-US";
  if (!model.includes("whisper")) return trimmed;
  if (trimmed.toLowerCase() === "multi") return "multi";
  return trimmed.split("-")[0]?.toLowerCase() ?? trimmed.toLowerCase();
}

function recognize(
  client: RivaRecognizeClient,
  request: RivaRecognizeRequest,
  metadata: grpc.Metadata,
  options: grpc.CallOptions & { signal: AbortSignal },
): Promise<RivaRecognizeResponse> {
  return new Promise((resolve, reject) => {
    const call = client.Recognize(request, metadata, options, (error, response) => {
      if (error !== null) {
        reject(
          new AudioProviderUpstreamError(
            `nvidia riva grpc error ${error.code}: ${error.details}`,
            grpcStatusToHttp(error.code),
            retryableGrpcStatus(error.code),
            error.details,
          ),
        );
        return;
      }
      resolve(response ?? {});
    });
    options.signal.addEventListener("abort", () => {
      call.cancel();
      reject(
        new AudioProviderUpstreamError(
          "nvidia riva grpc request aborted",
          504,
          true,
          "deadline exceeded",
        ),
      );
    }, { once: true });
  });
}

function normalizeRivaResponse(response: RivaRecognizeResponse): Record<string, unknown> {
  const results = response.results ?? [];
  const text = results
    .map((result) => result.alternatives?.[0]?.transcript ?? "")
    .filter((part) => part.length > 0)
    .join(" ");
  return { text, riva: response };
}

function grpcStatusToHttp(code: grpc.status): number {
  if (code === grpc.status.UNAUTHENTICATED) return 401;
  if (code === grpc.status.PERMISSION_DENIED) return 403;
  if (code === grpc.status.INVALID_ARGUMENT) return 400;
  if (code === grpc.status.NOT_FOUND) return 404;
  if (code === grpc.status.RESOURCE_EXHAUSTED) return 429;
  if (code === grpc.status.DEADLINE_EXCEEDED) return 504;
  if (code === grpc.status.UNAVAILABLE) return 503;
  return 502;
}

function retryableGrpcStatus(code: grpc.status): boolean {
  return (
    code === grpc.status.RESOURCE_EXHAUSTED ||
    code === grpc.status.DEADLINE_EXCEEDED ||
    code === grpc.status.UNAVAILABLE ||
    code === grpc.status.INTERNAL
  );
}
