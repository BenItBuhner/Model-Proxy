import type { ProviderType } from "@model-proxy/contracts/schemas/provider.ts";

import { providerConfigLoader } from "../config/provider-loader.ts";
import type { BaseProvider } from "./base.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { CodexProvider } from "./codex-provider.ts";
import { GeminiOpenAIProvider } from "./gemini-provider.ts";
import { OpenAIProvider } from "./openai-provider.ts";
import { OpenCodeProvider } from "./opencode-provider.ts";
import { SuperGrokProvider } from "./supergrok-provider.ts";

type ProviderFactory = () => BaseProvider;

/**
 * Providers are fully data-driven: dropping a JSON file into
 * `config/providers/` is all it takes. The optional `type` field in the JSON
 * selects the runtime adapter; plain OpenAI-compatible upstreams (the vast
 * majority) need no type at all.
 */
const typeFactories: Record<ProviderType, (name: string) => BaseProvider> = {
  "openai-compat": (name) => new OpenAIProvider(name),
  anthropic: (name) => new AnthropicProvider(name),
  gemini: (name) => new GeminiOpenAIProvider(name),
  opencode: (name) => new OpenCodeProvider(name),
  codex: (name) => new CodexProvider(name),
  supergrok: (name) => new SuperGrokProvider(name),
};

/** Well-known names keep their specialty adapters when `type` is omitted. */
const inferredTypeByName: Record<string, ProviderType> = {
  anthropic: "anthropic",
  gemini: "gemini",
  opencode: "opencode",
  codex: "codex",
  supergrok: "supergrok",
};

const customFactories = new Map<string, ProviderFactory>();

function resolveProviderType(providerName: string): ProviderType {
  const config = providerConfigLoader.loadProvider(providerName);
  const declared = config.type;
  if (declared !== undefined) return declared;
  return inferredTypeByName[providerName] ?? "openai-compat";
}

export const providerRegistry = {
  getProvider(providerName: string): BaseProvider {
    const custom = customFactories.get(providerName);
    if (custom !== undefined) return custom();
    const type = resolveProviderType(providerName);
    return typeFactories[type](providerName);
  },

  isValidProvider(providerName: string): boolean {
    if (customFactories.has(providerName)) return true;
    try {
      providerConfigLoader.loadProvider(providerName);
      return true;
    } catch {
      return false;
    }
  },

  getAvailableProviders(): string[] {
    return Array.from(
      new Set([
        ...providerConfigLoader.getAvailableProviders(),
        ...customFactories.keys(),
      ]),
    ).sort();
  },

  registerProvider(providerName: string, factory: ProviderFactory): void {
    customFactories.set(providerName, factory);
  },

  unregisterProvider(providerName: string): boolean {
    return customFactories.delete(providerName);
  },
};
