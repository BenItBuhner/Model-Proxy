import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PricingConfig } from "../../shared/schemas/pricing.ts";
import { PricingConfigSchema } from "../../shared/schemas/pricing.ts";
import { getStorageDir } from "./storage-paths.ts";

export interface AnalyticsPricingSettings {
  default_pricing?: PricingConfig;
}

export const BUILTIN_DEFAULT_PRICING: PricingConfig = {
  user_cost: {
    input_per_1m: 0,
    output_per_1m: 0,
  },
  typical_cost: {
    input_per_1m: 3,
    output_per_1m: 15,
  },
};

export function readAnalyticsPricingSettings(): AnalyticsPricingSettings {
  const path = pricingPath();
  if (!existsSync(path)) return { default_pricing: BUILTIN_DEFAULT_PRICING };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const defaultPricing = parsed["default_pricing"];
    if (defaultPricing !== undefined) {
      const result = PricingConfigSchema.safeParse(defaultPricing);
      if (result.success) return { default_pricing: result.data };
    }
    return { default_pricing: BUILTIN_DEFAULT_PRICING };
  } catch {
    return { default_pricing: BUILTIN_DEFAULT_PRICING };
  }
}

export function writeAnalyticsPricingSettings(settings: AnalyticsPricingSettings): AnalyticsPricingSettings {
  const normalized: AnalyticsPricingSettings = {};
  if (settings.default_pricing !== undefined) {
    normalized.default_pricing = PricingConfigSchema.parse(settings.default_pricing);
  }
  writeFileSync(pricingPath(), JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

function pricingPath(): string {
  return join(getStorageDir("analytics"), "pricing.json");
}
