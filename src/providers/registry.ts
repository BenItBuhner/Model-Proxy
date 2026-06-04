import type { BaseProvider } from "./base.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { GeminiOpenAIProvider } from "./gemini-provider.ts";
import { OpenAIProvider } from "./openai-provider.ts";
import { OpenCodeProvider } from "./opencode-provider.ts";

type ProviderFactory = () => BaseProvider;

const defaultFactories: Record<string, ProviderFactory> = {
  openai: () => new OpenAIProvider("openai"),
  openrouter: () => new OpenAIProvider("openrouter"),
  nahcrof: () => new OpenAIProvider("nahcrof"),
  groq: () => new OpenAIProvider("groq"),
  cerebras: () => new OpenAIProvider("cerebras"),
  llama: () => new OpenAIProvider("llama"),
  mistral: () => new OpenAIProvider("mistral"),
  cloudflare: () => new OpenAIProvider("cloudflare"),
  chutes: () => new OpenAIProvider("chutes"),
  longcat: () => new OpenAIProvider("longcat"),
  zai: () => new OpenAIProvider("zai"),
  nvidia: () => new OpenAIProvider("nvidia"),
  "local-llama": () => new OpenAIProvider("local-llama"),
  github: () => new OpenAIProvider("github"),
  opencode: () => new OpenCodeProvider(),

  gemini: () => new GeminiOpenAIProvider(),
  anthropic: () => new AnthropicProvider(),
};

const customFactories = new Map<string, ProviderFactory>();

function resolveFactory(providerName: string): ProviderFactory | undefined {
  return customFactories.get(providerName) ?? defaultFactories[providerName];
}

export const providerRegistry = {
  getProvider(providerName: string): BaseProvider {
    const factory = resolveFactory(providerName);
    if (factory === undefined) {
      const available = [
        ...Object.keys(defaultFactories),
        ...customFactories.keys(),
      ].sort();
      throw new Error(
        `Unknown provider: '${providerName}'. Available: ${available.join(", ")}`,
      );
    }
    return factory();
  },

  isValidProvider(providerName: string): boolean {
    return resolveFactory(providerName) !== undefined;
  },

  getAvailableProviders(): string[] {
    return [
      ...Object.keys(defaultFactories),
      ...customFactories.keys(),
    ].sort();
  },

  registerProvider(providerName: string, factory: ProviderFactory): void {
    customFactories.set(providerName, factory);
  },

  unregisterProvider(providerName: string): boolean {
    return customFactories.delete(providerName);
  },
};
