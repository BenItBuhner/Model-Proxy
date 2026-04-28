import type {
  AudioProviderAdapter,
} from "./base.ts";
import type { AudioProviderFormat } from "../../shared/schemas/audio-routing.ts";
import { NvidiaNimHttpAudioProvider } from "./nvidia-nim-http-audio-provider.ts";
import { NvidiaRivaGrpcAudioProvider } from "./nvidia-riva-grpc-audio-provider.ts";
import { OpenAICompatibleAudioProvider } from "./openai-compatible-audio-provider.ts";

const adapters = new Map<AudioProviderFormat, AudioProviderAdapter>([
  ["openai_audio", new OpenAICompatibleAudioProvider()],
  ["nvidia_nim_http", new NvidiaNimHttpAudioProvider()],
  ["nvidia_riva_grpc", new NvidiaRivaGrpcAudioProvider()],
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

