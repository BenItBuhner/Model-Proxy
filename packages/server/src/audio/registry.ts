import type { AudioProviderAdapter, AudioProviderCallContext, AudioProviderResponse } from "./base.ts";
import type { AudioProviderFormat } from "@model-proxy/contracts/schemas/audio-routing.ts";
import { NvidiaNimHttpAudioProvider } from "./nvidia-nim-http-audio-provider.ts";
import { OpenAICompatibleAudioProvider } from "./openai-compatible-audio-provider.ts";

/**
 * The Riva gRPC adapter drags in @grpc/proto-loader + protobufjs, which are
 * heavy and hostile to single-binary bundling. It is loaded lazily on the
 * first transcription that actually targets Riva.
 */
let rivaInstance: AudioProviderAdapter | undefined;
const lazyRivaAdapter: AudioProviderAdapter = {
  format: "nvidia_riva_grpc",
  async transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse> {
    if (rivaInstance === undefined) {
      const { NvidiaRivaGrpcAudioProvider } = await import(
        "./nvidia-riva-grpc-audio-provider.ts"
      );
      rivaInstance = new NvidiaRivaGrpcAudioProvider();
    }
    return rivaInstance.transcribe(ctx);
  },
};

const adapters = new Map<AudioProviderFormat, AudioProviderAdapter>([
  ["openai_audio", new OpenAICompatibleAudioProvider()],
  ["nvidia_nim_http", new NvidiaNimHttpAudioProvider()],
  ["nvidia_riva_grpc", lazyRivaAdapter],
]);

export function getAudioProviderAdapter(
  format: AudioProviderFormat,
): AudioProviderAdapter {
  const adapter = adapters.get(format);
  if (adapter === undefined) {
    throw new Error(`Unsupported audio provider format: ${format}`);
  }
  return adapter;
}
