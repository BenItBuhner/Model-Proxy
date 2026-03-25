/**
 * Provider Registry - Centralized factory for creating and managing provider instances.
 */
import { BaseProvider } from "./base.ts";
import type { OpenAIProvider } from "./openai-provider.ts";
import type { AnthropicProvider } from "./anthropic-provider.ts";
import type { GeminiProvider } from "./gemini-provider.ts";

type ProviderConstructor = new (...args: any[]) => BaseProvider;

let _providerClasses: Map<string, ProviderConstructor> | null = null;

function getProviderClasses(): Map<string, ProviderConstructor> {
  if (_providerClasses) return _providerClasses;

  // Lazy imports to avoid circular dependencies
  const { OpenAIProvider } = require("./openai-provider.ts");
  const { AnthropicProvider } = require("./anthropic-provider.ts");
  const { GeminiProvider } = require("./gemini-provider.ts");

  _providerClasses = new Map<string, ProviderConstructor>([
    // OpenAI-compatible providers
    ["openai", OpenAIProvider],
    ["openrouter", OpenAIProvider],
    ["nahcrof", OpenAIProvider],
    ["groq", OpenAIProvider],
    ["cerebras", OpenAIProvider],
    ["llama", OpenAIProvider],
    ["mistral", OpenAIProvider],
    ["cloudflare", OpenAIProvider],
    ["chutes", OpenAIProvider],
    ["longcat", OpenAIProvider],
    ["zai", OpenAIProvider],
    // Gemini uses dedicated OpenAI-compatible provider
    ["gemini", GeminiProvider],
    // Anthropic provider
    ["anthropic", AnthropicProvider],
    // Azure-based providers (use OpenAI provider - Azure is OpenAI-compatible)
    ["github", OpenAIProvider],
    ["azure", OpenAIProvider],
  ]);

  return _providerClasses;
}

export function createProvider(
  providerName: string,
  apiKey?: string | null,
  baseUrl?: string | null
): BaseProvider {
  const classes = getProviderClasses();
  let ProviderClass = classes.get(providerName);

  // If not a registered provider, try to determine the right class from config
  if (!ProviderClass) {
    // Check if there's a provider config for this name
    try {
      const { getProviderConfig, getProviderWireProtocol } = require("../core/provider-config.ts");
      const config = getProviderConfig(providerName);
      if (config) {
        const protocol = getProviderWireProtocol(providerName);
        if (protocol === "anthropic") {
          const { AnthropicProvider } = require("./anthropic-provider.ts");
          ProviderClass = AnthropicProvider;
        } else {
          // Default to OpenAI-compatible
          const { OpenAIProvider } = require("./openai-provider.ts");
          ProviderClass = OpenAIProvider;
        }
      }
    } catch {}
  }

  if (!ProviderClass) {
    const available = [...classes.keys()].sort().join(", ");
    throw new Error(`Unknown provider: '${providerName}'. Available providers: ${available}`);
  }

  // Create the provider instance
  const { AnthropicProvider } = require("./anthropic-provider.ts");
  const { GeminiProvider } = require("./gemini-provider.ts");

  let provider: BaseProvider;
  if (ProviderClass === AnthropicProvider || ProviderClass === GeminiProvider) {
    provider = new ProviderClass();
  } else {
    provider = new ProviderClass(providerName);
  }

  // Inject route-specific configuration
  if (apiKey != null || baseUrl != null) {
    provider.setRouteConfig(apiKey, baseUrl);
  }

  return provider;
}

export function isValidProvider(providerName: string): boolean {
  return getProviderClasses().has(providerName);
}

export function getAvailableProviders(): string[] {
  return [...getProviderClasses().keys()].sort();
}

export function registerProvider(name: string, cls: ProviderConstructor): void {
  getProviderClasses().set(name, cls);
}
