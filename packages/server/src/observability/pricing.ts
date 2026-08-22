import type { PricingConfig, TokenPricing } from "@model-proxy/contracts/schemas/pricing.ts";
import type { ModelRoutingConfig, RouteConfig } from "@model-proxy/contracts/schemas/routing.ts";
import { modelConfigLoader } from "../config/model-loader.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { readAnalyticsPricingSettings } from "../storage/pricing-store.ts";
import type { UsageSnapshot } from "./usage.ts";

export interface PricingLookupInput {
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  apiKeyEnvVar?: string;
}

const ZERO_PRICING: PricingConfig = {
  user_cost: { input_per_1m: 0, output_per_1m: 0 },
  typical_cost: { input_per_1m: 0, output_per_1m: 0 },
};

export function resolvePricing(input: PricingLookupInput): PricingConfig {
  const routePricing = pricingFromMatchingRoute(input);
  if (routePricing !== undefined) return routePricing;

  const providerPricing = pricingFromProvider(input);
  if (providerPricing !== undefined) return providerPricing;

  const logical = loadLogicalModel(input.requestedModel);
  if (logical?.pricing !== undefined) return logical.pricing;

  return readAnalyticsPricingSettings().default_pricing ?? ZERO_PRICING;
}

export function calculateCosts(usage: UsageSnapshot, pricing: PricingConfig): {
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
} {
  const userCostUsd = costFor(usage, pricing.user_cost);
  const typicalCostUsd = costFor(usage, pricing.typical_cost);
  return {
    userCostUsd,
    typicalCostUsd,
    savedCostUsd: Math.max(0, typicalCostUsd - userCostUsd),
  };
}

function pricingFromMatchingRoute(input: PricingLookupInput): PricingConfig | undefined {
  const logical = loadLogicalModel(input.requestedModel);
  if (logical === undefined) return undefined;
  const route = logical.model_routings.find((candidate) => routeMatches(candidate, input));
  return route?.pricing;
}

function pricingFromProvider(input: PricingLookupInput): PricingConfig | undefined {
  if (input.resolvedProvider === undefined) return undefined;
  try {
    const provider = providerConfigLoader.loadProvider(input.resolvedProvider);
    if (input.apiKeyEnvVar !== undefined) {
      const perKey = provider.api_keys.pricing_by_env_var?.[input.apiKeyEnvVar];
      if (perKey !== undefined) return perKey;
    }
    const modelPricing = pricingFromProviderModel(provider.models[input.resolvedModel ?? ""]);
    if (modelPricing !== undefined) return modelPricing;
    return provider.default_pricing;
  } catch {
    return undefined;
  }
}

function pricingFromProviderModel(value: unknown): PricingConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const pricing = (value as Record<string, unknown>)["pricing"];
  if (typeof pricing === "object" && pricing !== null) {
    return pricing as PricingConfig;
  }
  return undefined;
}

function loadLogicalModel(name: string): ModelRoutingConfig | undefined {
  try {
    return modelConfigLoader.loadConfig(name);
  } catch {
    return undefined;
  }
}

function routeMatches(route: RouteConfig, input: PricingLookupInput): boolean {
  if (input.resolvedProvider !== undefined && route.provider !== input.resolvedProvider) return false;
  if (input.resolvedModel !== undefined && route.model !== input.resolvedModel) return false;
  if (
    input.apiKeyEnvVar !== undefined &&
    route.api_key_env !== undefined &&
    route.api_key_env.length > 0 &&
    !route.api_key_env.includes(input.apiKeyEnvVar)
  ) {
    return false;
  }
  return true;
}

function costFor(usage: UsageSnapshot, pricing: TokenPricing): number {
  const inputTokens = Math.max(0, (usage.promptTokens ?? 0) - (usage.cacheReadTokens ?? 0));
  const outputTokens = usage.completionTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_1m;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_1m;
  const cacheReadCost =
    (cacheReadTokens / 1_000_000) * (pricing.cache_read_per_1m ?? pricing.input_per_1m);
  const cacheCreationCost =
    (cacheCreationTokens / 1_000_000) * (pricing.cache_creation_per_1m ?? pricing.input_per_1m);
  return roundMoney(inputCost + outputCost + cacheReadCost + cacheCreationCost);
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
